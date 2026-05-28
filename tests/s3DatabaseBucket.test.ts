import {describe, test, expect, vi, beforeEach} from 'vitest';
import {PutObjectCommand, GetObjectCommand} from '@aws-sdk/client-s3';
import type {S3Client} from '@aws-sdk/client-s3';
import type {Logger, Config} from '@verdaccio/types';

import S3Database from '../src/s3Database';
import S3PackageManager from '../src/s3PackageManager';

const DB_KEY = 'prefix/verdaccio-s3-db.json';

const logger: Logger = {
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  child: vi.fn(),
  http: vi.fn(),
  trace: vi.fn(),
} as any;

let s3SendSpy: ReturnType<typeof vi.fn>;

vi.mock('../src/s3Client', () => ({
  createS3Client: vi.fn(() => ({
    send: (...args: any[]) => (s3SendSpy as (...args: any[]) => any)(...args),
  })),
}));

type SendHandler = (command: any) => any;

function createFakeS3(handler: SendHandler): S3Client & {send: ReturnType<typeof vi.fn>} {
  return {
    send: vi.fn(async (command: any) => {
      const result = handler(command);
      if (result instanceof Error) throw result;
      return result;
    }),
  } as any;
}

function s3Error(name: string, statusCode = 500): Error {
  const err: any = new Error(name);
  err.name = name;
  err.$metadata = {httpStatusCode: statusCode};
  return err;
}

function localStorageBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    secret: '',
    list: [],
    tokens: [],
    ...overrides,
  });
}

function makeDbConfig() {
  return {
    store: {
      'aws-s3-storage': {
        bucket: 'test-bucket',
        keyPrefix: 'prefix',
        region: 'us-east-1',
        dynamoTableName: 'none',
      },
    },
  } as unknown as Config;
}

function createDb(): S3Database {
  return new S3Database(makeDbConfig(), {logger, config: makeDbConfig()});
}

function cbToPromise<T = any>(fn: (cb: (...args: any[]) => void) => void): Promise<T[]> {
  return new Promise((resolve) => {
    fn((...args: any[]) => resolve(args));
  });
}

function getPutBody(spy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const putCall = spy.mock.calls.find((c) => c[0] instanceof PutObjectCommand)?.[0];
  return JSON.parse(putCall.input.Body);
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('S3Database (bucket storage)', () => {
  beforeEach(() => {
    s3SendSpy = createFakeS3(() => ({})).send;
  });

  describe('constructor', () => {
    test('throws when config is falsy', () => {
      expect(() => new S3Database(null as any, {logger, config: {} as any})).toThrow(
        's3 storage missing config'
      );
    });

    test('throws when bucket is missing', () => {
      const config = {store: {'aws-s3-storage': {dynamoTableName: 'none'}}} as unknown as Config;
      expect(() => new S3Database(config, {logger, config})).toThrow('requires a bucket');
    });

    test('throws when dynamoTableName is missing', () => {
      const config = {store: {'aws-s3-storage': {bucket: 'b'}}} as unknown as Config;
      expect(() => new S3Database(config, {logger, config})).toThrow('requires a dynamoTableName');
    });

    test('creates instance with valid config', () => {
      const db = createDb();
      expect(db).toBeDefined();
      expect(db.config.bucket).toBe('test-bucket');
    });
  });

  describe('init', () => {
    test('loads registry data from S3', async () => {
      s3SendSpy = createFakeS3((cmd) => {
        if (cmd instanceof GetObjectCommand) {
          return {
            Body: {
              transformToString: async () =>
                localStorageBody({secret: 'loaded-secret', list: ['pkg-a']}),
            },
          };
        }
        return {};
      }).send;

      const db = createDb();
      await db.init();
      expect(await db.getSecret()).toBe('loaded-secret');

      const getCall = s3SendSpy.mock.calls[0][0];
      expect(getCall).toBeInstanceOf(GetObjectCommand);
      expect(getCall.input.Key).toBe(DB_KEY);
    });

    test('creates registry file when missing', async () => {
      s3SendSpy = createFakeS3((cmd) => {
        if (cmd instanceof GetObjectCommand) throw s3Error('NoSuchKey', 404);
        return {};
      }).send;

      const db = createDb();
      await db.init();
      await flushAsync();

      const putCall = s3SendSpy.mock.calls.find((c) => c[0] instanceof PutObjectCommand)?.[0];
      expect(putCall).toBeInstanceOf(PutObjectCommand);
      expect(putCall.input.Key).toBe(DB_KEY);
      expect(JSON.parse(putCall.input.Body)).toEqual({secret: '', list: [], tokens: []});
    });
  });

  describe('getSecret', () => {
    test('returns secret from in-memory store', async () => {
      s3SendSpy = createFakeS3(() => ({})).send;
      const db = createDb();
      await db.setSecret('my-secret');
      expect(await db.getSecret()).toBe('my-secret');
    });

    test('returns empty string when no secret is set', async () => {
      s3SendSpy = createFakeS3(() => ({})).send;
      const db = createDb();
      expect(await db.getSecret()).toBe('');
    });
  });

  describe('setSecret', () => {
    test('persists secret to S3', async () => {
      s3SendSpy = createFakeS3(() => ({})).send;
      const db = createDb();
      await db.setSecret('new-secret');
      await flushAsync();

      const body = getPutBody(s3SendSpy);
      expect(body.secret).toBe('new-secret');

      const putCall = s3SendSpy.mock.calls[0][0];
      expect(putCall).toBeInstanceOf(PutObjectCommand);
      expect(putCall.input.Bucket).toBe('test-bucket');
      expect(putCall.input.Key).toBe(DB_KEY);
    });
  });

  describe('add', () => {
    test('adds package and persists list to S3', async () => {
      s3SendSpy = createFakeS3(() => ({})).send;
      const db = createDb();

      const [err] = await cbToPromise((cb) => db.add('jquery', cb));
      expect(err).toBeNull();
      await flushAsync();

      const body = getPutBody(s3SendSpy);
      expect(body.list).toEqual(['jquery']);
    });

    test('does not duplicate packages in list', async () => {
      s3SendSpy = createFakeS3(() => ({})).send;
      const db = createDb();

      await cbToPromise((cb) => db.add('jquery', cb));
      await flushAsync();
      s3SendSpy.mockClear();

      const [err] = await cbToPromise((cb) => db.add('jquery', cb));
      expect(err).toBeNull();
      await flushAsync();
      expect(s3SendSpy).not.toHaveBeenCalled();
    });

    test('forwards S3 errors', async () => {
      s3SendSpy = createFakeS3(() => {
        throw new Error('write failed');
      }).send;
      const db = createDb();

      const [err] = await cbToPromise((cb) => db.add('jquery', cb));
      expect(err).toBeTruthy();
      expect((err as any).message).toBe('write failed');
    });
  });

  describe('remove', () => {
    test('removes package and persists list to S3', async () => {
      s3SendSpy = createFakeS3((cmd) => {
        if (cmd instanceof GetObjectCommand) {
          return {
            Body: {
              transformToString: async () => localStorageBody({list: ['jquery', 'lodash']}),
            },
          };
        }
        return {};
      }).send;

      const db = createDb();
      await db.init();

      const [err] = await cbToPromise((cb) => db.remove('jquery', cb));
      expect(err).toBeNull();
      await flushAsync();

      const body = getPutBody(s3SendSpy);
      expect(body.list).toEqual(['lodash']);
    });

    test('succeeds when package is not in list', async () => {
      s3SendSpy = createFakeS3(() => ({})).send;
      const db = createDb();

      const [err] = await cbToPromise((cb) => db.remove('missing', cb));
      expect(err).toBeNull();
      await flushAsync();
      expect(s3SendSpy).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    test('returns all packages from local store', async () => {
      s3SendSpy = createFakeS3((cmd) => {
        if (cmd instanceof GetObjectCommand) {
          return {
            Body: {
              transformToString: async () =>
                localStorageBody({list: ['jquery', 'lodash', 'express']}),
            },
          };
        }
        return {};
      }).send;

      const db = createDb();
      await db.init();

      const [err, data] = await cbToPromise((cb) => db.get(cb));
      expect(err).toBeNull();
      expect(data).toEqual(['jquery', 'lodash', 'express']);
    });

    test('returns empty list when no packages', async () => {
      s3SendSpy = createFakeS3(() => ({})).send;
      const db = createDb();

      const [err, data] = await cbToPromise((cb) => db.get(cb));
      expect(err).toBeNull();
      expect(data).toEqual([]);
    });
  });

  describe('getPackageStorage', () => {
    test('returns an S3PackageManager instance', () => {
      const db = createDb();
      const pm = db.getPackageStorage('my-package');
      expect(pm).toBeInstanceOf(S3PackageManager);
    });
  });

  describe('search / filterByQuery / getScore', () => {
    test('search returns empty array', async () => {
      const db = createDb();
      const results = await db.search({} as any);
      expect(results).toEqual([]);
    });

    test('filterByQuery returns results as-is', async () => {
      const db = createDb();
      const input = [{package: {name: 'test'}}] as any;
      const results = await db.filterByQuery(input, {} as any);
      expect(results).toBe(input);
    });

    test('getScore returns default score', async () => {
      const db = createDb();
      const score = await db.getScore({} as any);
      expect(score.final).toBe(1);
      expect(score.detail.quality).toBe(1);
    });
  });

  describe('token operations', () => {
    test('saveToken persists token to S3', async () => {
      s3SendSpy = createFakeS3(() => ({})).send;
      const db = createDb();

      await db.saveToken({
        user: 'admin',
        key: 'tok-123',
        token: 'jwt-abc',
        readonly: false,
        created: '2025-01-01',
      } as any);
      await flushAsync();

      const body = getPutBody(s3SendSpy);
      expect(body.tokens).toHaveLength(1);
      expect((body.tokens as any[])[0]).toMatchObject({
        user: 'admin',
        key: 'tok-123',
        token: 'jwt-abc',
      });
    });

    test('deleteToken removes token and persists to S3', async () => {
      s3SendSpy = createFakeS3((cmd) => {
        if (cmd instanceof GetObjectCommand) {
          return {
            Body: {
              transformToString: async () =>
                localStorageBody({
                  tokens: [{user: 'admin', key: 'tok-123', token: 'jwt-abc', readonly: false}],
                }),
            },
          };
        }
        return {};
      }).send;

      const db = createDb();
      await db.init();
      s3SendSpy.mockClear();

      await db.deleteToken('admin', 'tok-123');
      await flushAsync();

      const body = getPutBody(s3SendSpy);
      expect(body.tokens).toEqual([]);
    });

    test('readTokens returns tokens for a user', async () => {
      s3SendSpy = createFakeS3((cmd) => {
        if (cmd instanceof GetObjectCommand) {
          return {
            Body: {
              transformToString: async () =>
                localStorageBody({
                  tokens: [
                    {
                      user: 'admin',
                      key: 'tok-1',
                      token: 'jwt-1',
                      readonly: false,
                      created: '2025-01-01',
                    },
                    {
                      user: 'admin',
                      key: 'tok-2',
                      token: 'jwt-2',
                      readonly: true,
                      created: '2025-02-01',
                    },
                  ],
                }),
            },
          };
        }
        return {};
      }).send;

      const db = createDb();
      await db.init();

      const tokens = await db.readTokens({user: 'admin'});
      expect(tokens).toHaveLength(2);
      expect(tokens[0].key).toBe('tok-1');
      expect(tokens[1].readonly).toBe(true);
    });

    test('readTokens returns empty array when no tokens', async () => {
      s3SendSpy = createFakeS3(() => ({})).send;
      const db = createDb();

      const tokens = await db.readTokens({user: 'nobody'});
      expect(tokens).toEqual([]);
    });
  });
});
