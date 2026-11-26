import type {Logger, Config} from '@verdaccio/types';

import S3Database from '../src/s3Database';
import S3PackageManager from '../src/s3PackageManager';

import {PutObjectCommand, GetObjectCommand, HeadObjectCommand} from '@aws-sdk/client-s3';
import type {S3Client} from '@aws-sdk/client-s3';
import {describe, test, expect, vi, beforeEach} from 'vitest';

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

function makeDbConfig(overrides: Record<string, unknown> = {}) {
  return {
    store: {
      'aws-s3-storage': {
        bucket: 'test-bucket',
        keyPrefix: 'prefix',
        region: 'us-east-1',
        dynamoTableName: 'none',
        ...overrides,
      },
    },
  } as unknown as Config;
}

function createDb(overrides: Record<string, unknown> = {}): S3Database {
  return new S3Database(makeDbConfig(overrides), {logger, config: makeDbConfig(overrides)});
}

type FakeBucket = {
  send: ReturnType<typeof vi.fn>;
  /** Current content of verdaccio-s3-db.json; `null` means the object does not exist. */
  body: string | null;
  etag: number;
  /** Parsed content of the database object. */
  db(): Record<string, any>;
  /** Simulates a write by another instance. */
  setDb(data: Record<string, unknown>): void;
  puts(): any[];
  /** Makes the next `count` GetObject calls fail with `err`. */
  failGets(err: Error, count?: number): void;
};

/**
 * A fake S3 holding only the database object. Every call yields to the event loop first, so
 * concurrent operations interleave as they would against a real store. With `enforceIfMatch`,
 * a PutObject whose IfMatch does not match the current ETag fails with 412, as AWS S3 does.
 */
function createFakeBucket(
  initial: Record<string, unknown> | null,
  {enforceIfMatch = false}: {enforceIfMatch?: boolean} = {}
): FakeBucket {
  let getFailures: {err: Error; count: number} | null = null;
  const bucket: FakeBucket = {
    body: initial === null ? null : JSON.stringify(initial, null, '  '),
    etag: 1,
    db: () => JSON.parse(bucket.body as string),
    setDb(data) {
      bucket.body = JSON.stringify(data, null, '  ');
      bucket.etag += 1;
    },
    puts: () =>
      bucket.send.mock.calls.map((c) => c[0]).filter((c) => c instanceof PutObjectCommand),
    failGets(err, count = 1) {
      getFailures = {err, count};
    },
    send: vi.fn(async (cmd: any) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (cmd instanceof GetObjectCommand) {
        if (getFailures && getFailures.count > 0) {
          getFailures.count -= 1;
          throw getFailures.err;
        }
        if (bucket.body === null) throw s3Error('NoSuchKey', 404);
        const body = bucket.body;
        return {ETag: `"${bucket.etag}"`, Body: {transformToString: async () => body}};
      }
      if (cmd instanceof PutObjectCommand) {
        if (enforceIfMatch && cmd.input.IfMatch && cmd.input.IfMatch !== `"${bucket.etag}"`) {
          throw s3Error('PreconditionFailed', 412);
        }
        bucket.body = cmd.input.Body as string;
        bucket.etag += 1;
        return {ETag: `"${bucket.etag}"`};
      }
      return {};
    }),
  };
  return bucket;
}

function useBucket(
  initial: Record<string, unknown> | null = {secret: '', list: [], tokens: []},
  options?: {enforceIfMatch?: boolean}
): FakeBucket {
  const bucket = createFakeBucket(initial, options);
  s3SendSpy = bucket.send;
  return bucket;
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
      // A missing key fails GetObject with NoSuchKey and HeadObject with NotFound, as S3 does.
      s3SendSpy = createFakeS3((cmd) => {
        if (cmd instanceof GetObjectCommand) throw s3Error('NoSuchKey', 404);
        if (cmd instanceof HeadObjectCommand) throw s3Error('NotFound', 404);
        return {};
      }).send;

      const db = createDb();
      await expect(db.init()).resolves.toBeUndefined();

      const commands = s3SendSpy.mock.calls.map((c) => c[0].constructor);
      expect(commands).toEqual([GetObjectCommand, PutObjectCommand]);
      const putCall = s3SendSpy.mock.calls[1][0];
      expect(putCall.input.Key).toBe(DB_KEY);
      expect(JSON.parse(putCall.input.Body)).toEqual({secret: '', list: [], tokens: []});
    });

    test('fails when the new registry file cannot be written', async () => {
      s3SendSpy = createFakeS3((cmd) => {
        if (cmd instanceof GetObjectCommand) throw s3Error('NoSuchKey', 404);
        if (cmd instanceof PutObjectCommand) throw s3Error('AccessDenied', 403);
        return {};
      }).send;

      const db = createDb();
      await expect(db.init()).rejects.toThrow('AccessDenied');
    });

    test('does not overwrite the registry file when it cannot be read', async () => {
      s3SendSpy = createFakeS3((cmd) => {
        if (cmd instanceof GetObjectCommand) throw s3Error('InternalError', 503);
        return {};
      }).send;

      const db = createDb();
      await expect(db.init()).rejects.toThrow('InternalError');
      await flushAsync();

      expect(s3SendSpy.mock.calls.some((c) => c[0] instanceof PutObjectCommand)).toBe(false);
    });

    test('does not overwrite the registry file when it is not valid JSON', async () => {
      s3SendSpy = createFakeS3((cmd) => {
        if (cmd instanceof GetObjectCommand) {
          return {Body: {transformToString: async () => '{"secret": "truncated'}};
        }
        return {};
      }).send;

      const db = createDb();
      await expect(db.init()).rejects.toThrow(SyntaxError);
      await flushAsync();

      expect(s3SendSpy.mock.calls.some((c) => c[0] instanceof PutObjectCommand)).toBe(false);
    });

    test('creating the registry file does not produce an unhandledRejection', async () => {
      s3SendSpy = createFakeS3((cmd) => {
        if (cmd instanceof GetObjectCommand) throw s3Error('NoSuchKey', 404);
        if (cmd instanceof HeadObjectCommand) throw s3Error('NotFound', 404);
        return {};
      }).send;

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);

      try {
        const db = createDb();
        await db.init();
        // Give Node a full turn to report an unhandled rejection, if there is one.
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }

      expect(unhandled).toEqual([]);
    });
  });

  describe('getSecret', () => {
    test('returns secret from in-memory store', async () => {
      useBucket();
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
      const bucket = useBucket();
      const db = createDb();
      await db.setSecret('new-secret');

      expect(bucket.db().secret).toBe('new-secret');

      const putCall = bucket.puts()[0];
      expect(putCall.input.Bucket).toBe('test-bucket');
      expect(putCall.input.Key).toBe(DB_KEY);
    });
  });

  describe('add', () => {
    test('adds package and persists list to S3', async () => {
      const bucket = useBucket();
      const db = createDb();

      const [err] = await cbToPromise((cb) => db.add('jquery', cb));
      expect(err).toBeNull();

      expect(bucket.db().list).toEqual(['jquery']);
    });

    test('does not duplicate packages in list', async () => {
      const bucket = useBucket();
      const db = createDb();

      await cbToPromise((cb) => db.add('jquery', cb));
      s3SendSpy.mockClear();

      const [err] = await cbToPromise((cb) => db.add('jquery', cb));
      expect(err).toBeNull();
      expect(bucket.puts()).toEqual([]);
      expect(bucket.db().list).toEqual(['jquery']);
    });

    test('forwards S3 errors', async () => {
      s3SendSpy = createFakeS3((cmd) => {
        if (cmd instanceof GetObjectCommand) {
          return {Body: {transformToString: async () => localStorageBody()}};
        }
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
      const bucket = useBucket();
      const db = createDb();

      const [err] = await cbToPromise((cb) => db.remove('missing', cb));
      expect(err).toBeNull();
      expect(bucket.puts()).toEqual([]);
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
      useBucket();
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

  describe('search', () => {
    test('search returns empty array', async () => {
      const db = createDb();
      const results = await db.search({} as any);
      expect(results).toEqual([]);
    });
  });

  describe('several instances on one bucket', () => {
    test('add() applies the change to the database read from S3, not to the in-memory copy', async () => {
      const bucket = useBucket({secret: 's', list: ['a'], tokens: []});
      const db = createDb();
      await db.init();
      bucket.setDb({secret: 's', list: ['a', 'b'], tokens: []});

      const [err] = await cbToPromise((cb) => db.add('c', cb));

      expect(err).toBeNull();
      expect(bucket.db().list).toEqual(['a', 'b', 'c']);
    });

    test('two instances adding different packages keep both entries', async () => {
      const bucket = useBucket();
      const first = createDb();
      const second = createDb();
      await first.init();
      await second.init();

      await cbToPromise((cb) => first.add('x', cb));
      await cbToPromise((cb) => second.add('y', cb));

      expect(bucket.db().list).toEqual(['x', 'y']);
    });

    test('add() of a name that is already in S3 does not write', async () => {
      const bucket = useBucket();
      const db = createDb();
      await db.init();
      bucket.setDb({secret: '', list: ['x'], tokens: []});

      const [err] = await cbToPromise((cb) => db.add('x', cb));

      expect(err).toBeNull();
      expect(bucket.puts()).toEqual([]);
    });

    test('remove() removes a name this instance has never seen and keeps the others', async () => {
      const bucket = useBucket();
      const db = createDb();
      await db.init();
      bucket.setDb({secret: '', list: ['x', 'y'], tokens: []});

      const [err] = await cbToPromise((cb) => db.remove('x', cb));

      expect(err).toBeNull();
      expect(bucket.db().list).toEqual(['y']);
    });

    test('parallel add() calls on one instance all end up in the list', async () => {
      const bucket = useBucket();
      const db = createDb();
      await db.init();

      const names = ['a', 'b', 'c', 'd', 'e'];
      const results = await Promise.all(names.map((n) => cbToPromise((cb) => db.add(n, cb))));

      expect(results.map(([err]) => err)).toEqual([null, null, null, null, null]);
      expect(bucket.db().list).toEqual(names);
    });

    test('setSecret() with the stored secret does not write', async () => {
      const bucket = useBucket({secret: 'same', list: ['a'], tokens: []});
      const db = createDb();
      await db.init();

      await db.setSecret('same');

      expect(bucket.puts()).toEqual([]);
    });

    test('setSecret() with a new secret keeps the list read from S3', async () => {
      const bucket = useBucket({secret: 'old', list: ['a'], tokens: []});
      const db = createDb();
      await db.init();
      bucket.setDb({secret: 'old', list: ['a', 'b'], tokens: []});

      await db.setSecret('new');

      expect(bucket.db()).toEqual({secret: 'new', list: ['a', 'b'], tokens: []});
      expect(await db.getSecret()).toBe('new');
    });

    test('get() returns the list read from S3', async () => {
      const bucket = useBucket({secret: '', list: ['a'], tokens: []});
      const db = createDb();
      await db.init();
      bucket.setDb({secret: '', list: ['a', 'b'], tokens: []});

      const [err, list] = await cbToPromise((cb) => db.get(cb));

      expect(err).toBeNull();
      expect(list).toEqual(['a', 'b']);
    });

    test('get() falls back to the in-memory list when the read fails', async () => {
      const bucket = useBucket({secret: '', list: ['a'], tokens: []});
      const db = createDb();
      await db.init();
      bucket.failGets(s3Error('InternalError', 503));

      const [err, list] = await cbToPromise((cb) => db.get(cb));

      expect(err).toBeNull();
      expect(list).toEqual(['a']);
      expect(logger.warn).toHaveBeenCalledWith(
        {error: 'InternalError'},
        expect.stringContaining('serving the in-memory list')
      );
    });

    test('search() iterates the list read from S3', async () => {
      const bucket = useBucket({secret: '', list: ['a'], tokens: []});
      const db = createDb();
      await db.init();
      bucket.setDb({secret: '', list: ['a', 'b'], tokens: []});

      const seen: string[] = [];
      await new Promise<void>((resolve) => {
        db.search(
          (item: {name: string}, done: () => void) => {
            seen.push(item.name);
            done();
          },
          () => resolve()
        );
      });

      expect(seen).toEqual(['a', 'b']);
    });

    test('search() falls back to the in-memory list when the read fails', async () => {
      const bucket = useBucket({secret: '', list: ['a'], tokens: []});
      const db = createDb();
      await db.init();
      bucket.failGets(s3Error('InternalError', 503));

      const seen: string[] = [];
      await new Promise<void>((resolve) => {
        db.search(
          (item: {name: string}, done: () => void) => {
            seen.push(item.name);
            done();
          },
          () => resolve()
        );
      });

      expect(seen).toEqual(['a']);
    });

    test('the written file keeps the existing format, field order and unknown fields', async () => {
      const bucket = useBucket({secret: 's', list: ['a'], tokens: [], extra: {kept: true}});
      const db = createDb();
      await db.init();

      await cbToPromise((cb) => db.add('b', cb));

      expect(bucket.body).toBe(
        JSON.stringify({secret: 's', list: ['a', 'b'], tokens: [], extra: {kept: true}}, null, '  ')
      );
    });

    test('a failed read fails add() without writing', async () => {
      const bucket = useBucket();
      const db = createDb();
      await db.init();
      bucket.failGets(s3Error('InternalError', 503));

      const [err] = await cbToPromise((cb) => db.add('x', cb));

      expect((err as Error).message).toBe('InternalError');
      expect(bucket.puts()).toEqual([]);
    });

    test('a failed operation does not block the next one', async () => {
      const bucket = useBucket();
      const db = createDb();
      await db.init();
      bucket.failGets(s3Error('InternalError', 503));

      await cbToPromise((cb) => db.add('x', cb));
      const [err] = await cbToPromise((cb) => db.add('y', cb));

      expect(err).toBeNull();
      expect(bucket.db().list).toEqual(['y']);
    });
  });

  describe('conditionalWrites', () => {
    test('is off by default: the write has no If-Match', async () => {
      const bucket = useBucket();
      const db = createDb();
      await db.init();

      await cbToPromise((cb) => db.add('x', cb));

      expect(bucket.puts()[0].input.IfMatch).toBeUndefined();
    });

    test('sends If-Match with the ETag from the read', async () => {
      const bucket = useBucket();
      const db = createDb({conditionalWrites: true});
      await db.init();
      const etag = `"${bucket.etag}"`;

      await cbToPromise((cb) => db.add('x', cb));

      expect(bucket.puts()[0].input.IfMatch).toBe(etag);
    });

    test('retries on 412 with a fresh read and keeps the other write', async () => {
      const bucket = useBucket(undefined, {enforceIfMatch: true});
      const db = createDb({conditionalWrites: true});
      await db.init();

      // Another instance writes between this instance's read and write.
      const originalSend = bucket.send.getMockImplementation()!;
      let raced = false;
      bucket.send.mockImplementation(async (cmd: any) => {
        if (cmd instanceof PutObjectCommand && !raced) {
          raced = true;
          bucket.setDb({secret: '', list: ['other'], tokens: []});
        }
        return originalSend(cmd);
      });

      const [err] = await cbToPromise((cb) => db.add('x', cb));

      expect(err).toBeNull();
      expect(bucket.db().list).toEqual(['other', 'x']);
      expect(bucket.puts()).toHaveLength(2);
    });

    test('fails after 5 attempts without writing', async () => {
      const bucket = useBucket(undefined, {enforceIfMatch: true});
      const db = createDb({conditionalWrites: true});
      await db.init();

      // Another instance writes before every write of this one.
      const originalSend = bucket.send.getMockImplementation()!;
      bucket.send.mockImplementation(async (cmd: any) => {
        if (cmd instanceof PutObjectCommand) {
          bucket.setDb({...bucket.db(), list: [...bucket.db().list, 'other']});
        }
        return originalSend(cmd);
      });

      const [err] = await cbToPromise((cb) => db.add('x', cb));

      expect((err as Error).message).toContain('after 5 attempts');
      expect(bucket.puts()).toHaveLength(5);
      expect(bucket.db().list).not.toContain('x');
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
