import {describe, test, expect, vi} from 'vitest';
import {PassThrough} from 'stream';
import {HeadObjectCommand, PutObjectCommand, DeleteObjectCommand} from '@aws-sdk/client-s3';
import type {S3Client} from '@aws-sdk/client-s3';
import type {Logger, Package} from '@verdaccio/types';

import S3PackageManager from '../src/s3PackageManager';
import type {S3Config} from '../types';

const logger: Logger = {
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  child: vi.fn(),
  http: vi.fn(),
  trace: vi.fn(),
} as any;

const pkg: Package = {
  name: 'test-package',
  versions: {},
  'dist-tags': {},
  _attachments: {},
  _uplinks: {},
  _rev: '',
} as Package;

function makeConfig(overrides: Partial<S3Config> = {}): S3Config {
  return {
    bucket: 'test-bucket',
    keyPrefix: 'prefix/',
    dynamoTableName: 'test-table',
    ...overrides,
  } as S3Config;
}

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

function cbToPromise<T = any>(fn: (cb: (...args: any[]) => void) => void): Promise<T[]> {
  return new Promise((resolve) => {
    fn((...args: any[]) => resolve(args));
  });
}

describe('S3PackageManager', () => {
  describe('constructor', () => {
    test('builds packagePath with keyPrefix', () => {
      const s3 = createFakeS3(() => ({}));
      const pm = new S3PackageManager(makeConfig(), 'my-pkg', logger, s3);
      expect(pm).toBeDefined();
      expect(pm.config.bucket).toBe('test-bucket');
    });

    test('uses custom storage folder when getMatchedPackagesSpec returns storage', () => {
      const config = makeConfig({
        getMatchedPackagesSpec: vi.fn(() => ({storage: 'custom'})),
      } as any);
      const s3 = createFakeS3(() => ({}));
      const pm = new S3PackageManager(config, '@scope/pkg', logger, s3);
      expect(pm).toBeDefined();
    });
  });

  describe('createPackage', () => {
    test('creates a new package when it does not exist', async () => {
      const s3 = createFakeS3((cmd) => {
        if (cmd instanceof HeadObjectCommand) throw s3Error('NotFound', 404);
        return {};
      });

      const pm = new S3PackageManager(makeConfig(), 'new-pkg', logger, s3);
      const [err] = await cbToPromise((cb) => pm.createPackage('test.tgz', pkg, cb));
      expect(err).toBeNull();
    });

    test('returns 409 when package already exists', async () => {
      const s3 = createFakeS3((cmd) => {
        if (cmd instanceof HeadObjectCommand) return {};
        return {};
      });

      const pm = new S3PackageManager(makeConfig(), 'existing-pkg', logger, s3);
      const [err] = await cbToPromise((cb) => pm.createPackage('test.tgz', pkg, cb));
      expect(err).toBeTruthy();
      expect((err as any).code).toBe(409);
    });
  });

  describe('savePackage', () => {
    test('puts object to S3', async () => {
      const s3 = createFakeS3(() => ({}));

      const pm = new S3PackageManager(makeConfig(), 'my-pkg', logger, s3);
      const [err] = await cbToPromise((cb) => pm.savePackage('pkg.json', pkg, cb));
      expect(err).toBeNull();

      const putCall = s3.send.mock.calls[0][0];
      expect(putCall).toBeInstanceOf(PutObjectCommand);
      expect(putCall.input.Bucket).toBe('test-bucket');
      expect(putCall.input.Body).toContain('test-package');
    });

    test('forwards S3 errors to callback', async () => {
      const s3 = createFakeS3(() => {
        throw new Error('S3 write failed');
      });

      const pm = new S3PackageManager(makeConfig(), 'my-pkg', logger, s3);
      const [err] = await cbToPromise((cb) => pm.savePackage('pkg.json', pkg, cb));
      expect(err).toBeTruthy();
      expect((err as any).message).toBe('S3 write failed');
    });
  });

  describe('readPackage', () => {
    test('reads and parses package from S3', async () => {
      const s3 = createFakeS3(() => ({
        Body: {transformToString: async () => JSON.stringify(pkg)},
      }));

      const pm = new S3PackageManager(makeConfig(), 'my-pkg', logger, s3);
      const [err, data] = await cbToPromise((cb) => pm.readPackage('pkg.json', cb));
      expect(err).toBeNull();
      expect(data.name).toBe('test-package');
    });

    test('returns error when package does not exist', async () => {
      const s3 = createFakeS3(() => {
        throw s3Error('NoSuchKey', 404);
      });

      const pm = new S3PackageManager(makeConfig(), 'missing-pkg', logger, s3);
      const [err] = await cbToPromise((cb) => pm.readPackage('pkg.json', cb));
      expect(err).toBeTruthy();
      expect((err as any).code).toBe(404);
    });
  });

  describe('deletePackage', () => {
    test('deletes object from S3', async () => {
      const s3 = createFakeS3(() => ({}));

      const pm = new S3PackageManager(makeConfig(), 'my-pkg', logger, s3);
      const [err] = await cbToPromise((cb) => pm.deletePackage('test-file.tgz', cb));
      expect(err).toBeNull();

      const deleteCall = s3.send.mock.calls[0][0];
      expect(deleteCall).toBeInstanceOf(DeleteObjectCommand);
      expect(deleteCall.input.Key).toContain('test-file.tgz');
    });
  });

  describe('removePackage', () => {
    test('removes all objects under package prefix', async () => {
      const s3 = createFakeS3((cmd) => {
        const name = cmd.constructor.name;
        if (name === 'ListObjectsV2Command') {
          return {KeyCount: 1, Contents: [{Key: 'prefix/my-pkg/package.json'}]};
        }
        return {};
      });

      const pm = new S3PackageManager(makeConfig(), 'my-pkg', logger, s3);
      const [err] = await cbToPromise((cb) => pm.removePackage(cb));
      expect(err).toBeNull();
    });

    test('succeeds even when package prefix is empty (404)', async () => {
      const s3 = createFakeS3((cmd) => {
        const name = cmd.constructor.name;
        if (name === 'ListObjectsV2Command') {
          return {KeyCount: 0, Contents: []};
        }
        return {};
      });

      const pm = new S3PackageManager(makeConfig(), 'empty-pkg', logger, s3);
      const [err] = await cbToPromise((cb) => pm.removePackage(cb));
      expect(err).toBeNull();
    });
  });

  describe('updatePackage', () => {
    test('reads data, calls updateHandler, transforms, and writes', async () => {
      const pkgData = {...pkg, _rev: '1'};
      const s3 = createFakeS3(() => ({
        Body: {transformToString: async () => JSON.stringify(pkgData)},
      }));

      const pm = new S3PackageManager(makeConfig(), 'my-pkg', logger, s3);

      const updateHandler = vi.fn((_json: any, cb: any) => cb(null));
      const transformPackage = vi.fn((json: any) => ({...json, _rev: '2'}));
      const onWrite = vi.fn((_name: string, _pkg: any, cb: any) => cb(null));

      const [err] = await cbToPromise((cb) =>
        pm.updatePackage('my-pkg', updateHandler, onWrite, transformPackage, cb)
      );
      expect(err).toBeNull();
      expect(updateHandler).toHaveBeenCalledOnce();
      expect(transformPackage).toHaveBeenCalledOnce();
      expect(onWrite).toHaveBeenCalledOnce();
    });

    test('forwards error from _getData', async () => {
      const s3 = createFakeS3(() => {
        throw s3Error('NoSuchKey', 404);
      });

      const pm = new S3PackageManager(makeConfig(), 'missing', logger, s3);
      const [err] = await cbToPromise((cb) =>
        pm.updatePackage('missing', vi.fn(), vi.fn(), vi.fn(), cb)
      );
      expect(err).toBeTruthy();
    });

    test('forwards error from updateHandler', async () => {
      const s3 = createFakeS3(() => ({
        Body: {transformToString: async () => JSON.stringify(pkg)},
      }));

      const pm = new S3PackageManager(makeConfig(), 'my-pkg', logger, s3);
      const updateErr = new Error('update failed');

      const [err] = await cbToPromise((cb) =>
        pm.updatePackage(
          'my-pkg',
          (_json: any, innerCb: any) => innerCb(updateErr),
          vi.fn(),
          vi.fn(),
          cb
        )
      );
      expect(err).toBe(updateErr);
    });
  });

  describe('readTarball', () => {
    test('emits content-length, open, and pipes data', async () => {
      const bodyStream = new PassThrough();

      const s3 = createFakeS3(() => ({ContentLength: 1024, Body: bodyStream}));

      const pm = new S3PackageManager(makeConfig(), 'my-pkg', logger, s3);
      const stream = pm.readTarball('file.tgz');

      const events: string[] = [];
      let contentLength = 0;

      stream.on('content-length', (len: number) => {
        contentLength = len;
        events.push('content-length');
      });
      stream.on('open', () => events.push('open'));

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));

      await new Promise<void>((resolve) => {
        stream.on('end', () => {
          events.push('end');
          resolve();
        });
        setTimeout(() => {
          bodyStream.end(Buffer.from('tarball-data'));
        }, 10);
      });

      expect(contentLength).toBe(1024);
      expect(events).toContain('content-length');
      expect(events).toContain('open');
      expect(Buffer.concat(chunks).toString()).toBe('tarball-data');
    });

    test('emits error when object does not exist', async () => {
      const s3 = createFakeS3(() => {
        throw s3Error('NoSuchKey', 404);
      });

      const pm = new S3PackageManager(makeConfig(), 'my-pkg', logger, s3);
      const stream = pm.readTarball('missing.tgz');

      const err = await new Promise<any>((resolve) => {
        stream.on('error', resolve);
      });
      expect(err.code).toBe(404);
    });
  });

  describe('writeTarball', () => {
    test('emits error when file already exists', async () => {
      const s3 = createFakeS3((cmd) => {
        if (cmd instanceof HeadObjectCommand) return {};
        return {};
      });

      const pm = new S3PackageManager(makeConfig(), 'my-pkg', logger, s3);
      const stream = pm.writeTarball('existing.tgz');

      const err = await new Promise<any>((resolve) => {
        stream.on('error', resolve);
      });
      expect(err.code).toBe(409);
    });

    test('emits open when file does not exist', async () => {
      const s3 = createFakeS3((cmd) => {
        if (cmd instanceof HeadObjectCommand) throw s3Error('NotFound', 404);
        return {};
      });

      const pm = new S3PackageManager(makeConfig(), 'my-pkg', logger, s3);
      const stream = pm.writeTarball('new.tgz');

      const opened = await new Promise<boolean>((resolve) => {
        stream.on('open', () => resolve(true));
        stream.on('error', () => resolve(false));
      });
      expect(opened).toBe(true);
    });
  });

  describe('packagePath with custom storage', () => {
    test('uses custom storage prefix in S3 keys', async () => {
      const config = makeConfig({
        getMatchedPackagesSpec: vi.fn(() => ({storage: 'customFolder'})),
      } as any);

      const s3 = createFakeS3((cmd) => {
        if (cmd instanceof HeadObjectCommand) throw s3Error('NotFound', 404);
        return {};
      });

      const pm = new S3PackageManager(config, '@scope/pkg', logger, s3);
      const [err] = await cbToPromise((cb) => pm.createPackage('test', pkg, cb));
      expect(err).toBeNull();

      // HeadObject should have used the custom storage path
      const headCall = s3.send.mock.calls[0][0];
      expect(headCall.input.Key).toBe('prefix/customFolder/@scope/pkg/package.json');
      // PutObject should have used the same path
      const putCall = s3.send.mock.calls[1][0];
      expect(putCall.input.Key).toBe('prefix/customFolder/@scope/pkg/package.json');
    });

    test('uses default keyPrefix when no custom storage', async () => {
      const config = makeConfig({
        getMatchedPackagesSpec: vi.fn(() => null),
      } as any);

      const s3 = createFakeS3((cmd) => {
        if (cmd instanceof HeadObjectCommand) throw s3Error('NotFound', 404);
        return {};
      });

      const pm = new S3PackageManager(config, '@scope/pkg', logger, s3);
      const [err] = await cbToPromise((cb) => pm.createPackage('test', pkg, cb));
      expect(err).toBeNull();

      const headCall = s3.send.mock.calls[0][0];
      expect(headCall.input.Key).toBe('prefix/@scope/pkg/package.json');
      const putCall = s3.send.mock.calls[1][0];
      expect(putCall.input.Key).toBe('prefix/@scope/pkg/package.json');
    });
  });
});
