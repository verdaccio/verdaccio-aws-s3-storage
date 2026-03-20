import {describe, test, expect, vi, beforeEach} from 'vitest';
import {GetCommand, PutCommand, DeleteCommand, QueryCommand} from '@aws-sdk/lib-dynamodb';
import type {Logger, Config} from '@verdaccio/types';

import S3Database from '../src/s3Database';
import S3PackageManager from '../src/s3PackageManager';

const logger: Logger = {
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  child: vi.fn(),
  http: vi.fn(),
  trace: vi.fn(),
} as any;

let dynamoSendSpy: ReturnType<typeof vi.fn>;

vi.mock('../src/dynamoClient', () => ({
  createDynamoClient: vi.fn(() => ({
    send: (...args: any[]) => dynamoSendSpy(...args),
  })),
}));

vi.mock('../src/s3Client', () => ({
  createS3Client: vi.fn(() => ({})),
}));

function makeDbConfig() {
  return {
    store: {
      'aws-s3-storage': {
        bucket: 'test-bucket',
        keyPrefix: 'prefix',
        region: 'us-east-1',
        dynamoTableName: 'verdaccio-table',
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

describe('S3Database', () => {
  beforeEach(() => {
    dynamoSendSpy = vi.fn();
  });

  describe('constructor', () => {
    test('throws when config is falsy', () => {
      expect(() => new S3Database(null as any, {logger, config: {} as any})).toThrow(
        's3 storage missing config'
      );
    });

    test('throws when bucket is missing', () => {
      const config = {store: {'aws-s3-storage': {dynamoTableName: 'tbl'}}} as unknown as Config;
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

  describe('getSecret', () => {
    test('returns secret from DynamoDB', async () => {
      dynamoSendSpy.mockResolvedValue({Item: {secret: 'my-secret'}});
      const db = createDb();
      const secret = await db.getSecret();
      expect(secret).toBe('my-secret');

      const cmd = dynamoSendSpy.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(GetCommand);
      expect(cmd.input.Key).toEqual({pk: 'CONFIG', sk: 'SECRET'});
    });

    test('returns empty string when no secret exists', async () => {
      dynamoSendSpy.mockResolvedValue({});
      const db = createDb();
      expect(await db.getSecret()).toBe('');
    });

    test('returns empty string on dynamo error', async () => {
      dynamoSendSpy.mockRejectedValue(new Error('dynamo down'));
      const db = createDb();
      expect(await db.getSecret()).toBe('');
    });
  });

  describe('setSecret', () => {
    test('puts secret to DynamoDB', async () => {
      dynamoSendSpy.mockResolvedValue({});
      const db = createDb();
      await db.setSecret('new-secret');

      const cmd = dynamoSendSpy.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(PutCommand);
      expect(cmd.input.Item).toEqual({pk: 'CONFIG', sk: 'SECRET', secret: 'new-secret'});
    });
  });

  describe('add', () => {
    test('adds package to DynamoDB', async () => {
      dynamoSendSpy.mockResolvedValue({});
      const db = createDb();

      const [err] = await cbToPromise((cb) => db.add('jquery', cb));
      expect(err).toBeNull();
      const cmd = dynamoSendSpy.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(PutCommand);
      expect(cmd.input.Item).toEqual({pk: 'PACKAGE', sk: 'jquery', name: 'jquery'});
    });

    test('forwards dynamo errors', async () => {
      dynamoSendSpy.mockRejectedValue(new Error('write failed'));
      const db = createDb();

      const [err] = await cbToPromise((cb) => db.add('jquery', cb));
      expect(err).toBeTruthy();
      expect((err as any).message).toBe('write failed');
    });
  });

  describe('remove', () => {
    test('deletes package from DynamoDB', async () => {
      dynamoSendSpy.mockResolvedValue({});
      const db = createDb();

      const [err] = await cbToPromise((cb) => db.remove('jquery', cb));
      expect(err).toBeNull();
      const cmd = dynamoSendSpy.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(DeleteCommand);
      expect(cmd.input.Key).toEqual({pk: 'PACKAGE', sk: 'jquery'});
    });
  });

  describe('get', () => {
    test('queries all packages from DynamoDB', async () => {
      dynamoSendSpy.mockResolvedValue({
        Items: [{sk: 'jquery'}, {sk: 'lodash'}, {sk: 'express'}],
      });
      const db = createDb();

      const [err, data] = await cbToPromise((cb) => db.get(cb));
      expect(err).toBeNull();
      expect(data).toEqual(['jquery', 'lodash', 'express']);

      const cmd = dynamoSendSpy.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(QueryCommand);
      expect(cmd.input.ExpressionAttributeValues).toEqual({':pk': 'PACKAGE'});
    });

    test('returns empty list when no packages', async () => {
      dynamoSendSpy.mockResolvedValue({Items: []});
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
    test('search throws service unavailable', async () => {
      const db = createDb();
      await expect(db.search({} as any)).rejects.toMatchObject({code: 503});
    });

    test('filterByQuery throws service unavailable', async () => {
      const db = createDb();
      await expect(db.filterByQuery([], {} as any)).rejects.toMatchObject({code: 503});
    });

    test('getScore throws service unavailable', async () => {
      const db = createDb();
      await expect(db.getScore({} as any)).rejects.toMatchObject({code: 503});
    });
  });

  describe('token operations', () => {
    test('saveToken puts token to DynamoDB', async () => {
      dynamoSendSpy.mockResolvedValue({});
      const db = createDb();

      await db.saveToken({
        user: 'admin',
        key: 'tok-123',
        token: 'jwt-abc',
        readonly: false,
        created: '2025-01-01',
      } as any);

      const cmd = dynamoSendSpy.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(PutCommand);
      expect(cmd.input.Item.pk).toBe('TOKEN#admin');
      expect(cmd.input.Item.sk).toBe('tok-123');
      expect(cmd.input.Item.token).toBe('jwt-abc');
    });

    test('deleteToken removes token from DynamoDB', async () => {
      dynamoSendSpy.mockResolvedValue({});
      const db = createDb();

      await db.deleteToken('admin', 'tok-123');

      const cmd = dynamoSendSpy.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(DeleteCommand);
      expect(cmd.input.Key).toEqual({pk: 'TOKEN#admin', sk: 'tok-123'});
    });

    test('readTokens queries tokens for a user', async () => {
      dynamoSendSpy.mockResolvedValue({
        Items: [
          {user: 'admin', sk: 'tok-1', token: 'jwt-1', readonly: false, created: '2025-01-01'},
          {user: 'admin', sk: 'tok-2', token: 'jwt-2', readonly: true, created: '2025-02-01'},
        ],
      });
      const db = createDb();

      const tokens = await db.readTokens({user: 'admin'});
      expect(tokens).toHaveLength(2);
      expect(tokens[0].key).toBe('tok-1');
      expect(tokens[1].readonly).toBe(true);

      const cmd = dynamoSendSpy.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(QueryCommand);
      expect(cmd.input.ExpressionAttributeValues).toEqual({':pk': 'TOKEN#admin'});
    });

    test('readTokens returns empty array when no tokens', async () => {
      dynamoSendSpy.mockResolvedValue({Items: []});
      const db = createDb();

      const tokens = await db.readTokens({user: 'nobody'});
      expect(tokens).toEqual([]);
    });
  });
});
