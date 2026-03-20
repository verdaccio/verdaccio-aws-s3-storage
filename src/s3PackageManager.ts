import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import type {ObjectCannedACL, S3Client} from '@aws-sdk/client-s3';
import {Upload} from '@aws-sdk/lib-storage';
import type {Readable} from 'stream';
import debugCore from 'debug';

import {HEADERS} from '@verdaccio/core';
import type {Callback, Logger, Package, ReadPackageCallback} from '@verdaccio/types';
import {ReadTarball, UploadTarball} from '@verdaccio/streams';

import type {S3Config} from '../types';
import addTrailingSlash from './addTrailingSlash';
import {deleteKeyPrefix} from './deleteKeyPrefix';
import {convertS3Error, create409Error, is404Error} from './s3Errors';

const debug = debugCore('verdaccio:plugin:aws-s3-storage:package');

const pkgFileName = 'package.json';

export default class S3PackageManager {
  public config: S3Config;
  public logger: Logger;
  private readonly packageName: string;
  private readonly s3: S3Client;
  private readonly packagePath: string;
  private readonly tarballACL: ObjectCannedACL;

  public constructor(config: S3Config, packageName: string, logger: Logger, s3: S3Client) {
    this.config = config;
    this.packageName = packageName;
    this.logger = logger;
    this.s3 = s3;
    this.tarballACL = (config.tarballACL || 'private') as ObjectCannedACL;

    const packageAccess = this.config.getMatchedPackagesSpec
      ? this.config.getMatchedPackagesSpec(packageName)
      : undefined;
    if (packageAccess) {
      const storage = packageAccess.storage;
      const packageCustomFolder = addTrailingSlash(storage);
      this.packagePath = `${this.config.keyPrefix}${packageCustomFolder}${this.packageName}`;
    } else {
      this.packagePath = `${this.config.keyPrefix}${this.packageName}`;
    }

    debug(
      'init package=%o path=%o bucket=%o acl=%o customStorage=%o',
      packageName,
      this.packagePath,
      config.bucket,
      this.tarballACL,
      packageAccess?.storage ?? 'none'
    );
  }

  public updatePackage(
    name: string,
    updateHandler: Callback,
    onWrite: Callback,
    transformPackage: (pkg: Package) => Package,
    onEnd: Callback
  ): void {
    debug('updatePackage name=%o path=%o', name, this.packagePath);
    void (async (): Promise<void> => {
      try {
        const json = await this._getData();
        debug('updatePackage name=%o loaded, calling updateHandler', name);
        updateHandler(json, (err: any) => {
          if (err) {
            debug('updatePackage name=%o updateHandler error: %o', name, err);
            onEnd(err);
          } else {
            const transformedPackage = transformPackage(json);
            debug('updatePackage name=%o transformed, calling onWrite', name);
            onWrite(name, transformedPackage, onEnd);
          }
        });
      } catch (err) {
        debug('updatePackage name=%o getData failed: %o', name, err);
        return onEnd(err);
      }
    })();
  }

  private async _getData(): Promise<Package> {
    const key = `${this.packagePath}/${pkgFileName}`;
    debug('_getData bucket=%o key=%o', this.config.bucket, key);
    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      })
    );

    const bodyStr = (await response.Body?.transformToString()) ?? '';
    try {
      const data = JSON.parse(bodyStr);
      debug('_getData loaded package=%o versions=%d', data.name, Object.keys(data.versions || {}).length);
      return data;
    } catch (e) {
      debug('_getData JSON parse error for key=%o bodyLength=%d', key, bodyStr.length);
      throw e;
    }
  }

  public deletePackage(fileName: string, callback: Callback): void {
    const key = `${this.packagePath}/${fileName}`;
    debug('deletePackage bucket=%o key=%o', this.config.bucket, key);
    void (async (): Promise<void> => {
      try {
        await this.s3.send(
          new DeleteObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
          })
        );
        debug('deletePackage key=%o deleted', key);
        callback(null);
      } catch (err) {
        debug('deletePackage key=%o failed: %o', key, err);
        callback(err);
      }
    })();
  }

  public removePackage(callback: (err: Error | null) => void): void {
    const prefix = addTrailingSlash(this.packagePath);
    debug('removePackage bucket=%o prefix=%o', this.config.bucket, prefix);
    void (async (): Promise<void> => {
      try {
        await deleteKeyPrefix(this.s3, {
          Bucket: this.config.bucket,
          Prefix: prefix,
        });
        debug('removePackage prefix=%o removed', prefix);
        callback(null);
      } catch (err: any) {
        if (is404Error(err)) {
          debug('removePackage prefix=%o already empty (404), ignoring', prefix);
          callback(null);
        } else {
          debug('removePackage prefix=%o failed: %o', prefix, err);
          callback(err);
        }
      }
    })();
  }

  public createPackage(name: string, value: Package, callback: (err: Error | null) => void): void {
    const key = `${this.packagePath}/${pkgFileName}`;
    debug('createPackage name=%o bucket=%o key=%o', name, this.config.bucket, key);
    void (async (): Promise<void> => {
      try {
        await this.s3.send(
          new HeadObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
          })
        );
        debug('createPackage name=%o already exists → 409', name);
        callback(create409Error());
      } catch (headErr: any) {
        const s3Err = convertS3Error(headErr);
        if (is404Error(s3Err)) {
          debug('createPackage name=%o not found → creating', name);
          this.savePackage(name, value, callback);
        } else {
          debug('createPackage name=%o headObject error: %o', name, s3Err.message);
          callback(s3Err);
        }
      }
    })();
  }

  public savePackage(name: string, value: Package, callback: (err: Error | null) => void): void {
    const key = `${this.packagePath}/${pkgFileName}`;
    debug('savePackage name=%o bucket=%o key=%o', name, this.config.bucket, key);
    void (async (): Promise<void> => {
      try {
        await this.s3.send(
          new PutObjectCommand({
            Body: JSON.stringify(value, null, '  '),
            Bucket: this.config.bucket,
            Key: key,
          })
        );
        debug('savePackage name=%o saved', name);
        callback(null);
      } catch (err: any) {
        debug('savePackage name=%o failed: %o', name, err.message);
        callback(err);
      }
    })();
  }

  public readPackage(name: string, callback: ReadPackageCallback): void {
    debug('readPackage name=%o path=%o', name, this.packagePath);
    void (async (): Promise<void> => {
      try {
        const data = await this._getData();
        debug('readPackage name=%o success', name);
        callback(null, data);
      } catch (err: any) {
        debug('readPackage name=%o failed: %o', name, err.message);
        callback(convertS3Error(err));
      }
    })();
  }

  public writeTarball(name: string): UploadTarball {
    const key = `${this.packagePath}/${name}`;
    debug('writeTarball name=%o bucket=%o key=%o acl=%o', name, this.config.bucket, key, this.tarballACL);
    const uploadStream = new UploadTarball({});

    let streamEnded = 0;
    uploadStream.on('end', () => {
      debug('writeTarball name=%o stream ended', name);
      streamEnded = 1;
    });

    void (async (): Promise<void> => {
      try {
        await this.s3.send(
          new HeadObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
          })
        );
        debug('writeTarball name=%o already exists → 409', name);
        uploadStream.emit('error', create409Error());
      } catch (headErr: any) {
        const convertedErr = convertS3Error(headErr);
        if (!is404Error(convertedErr)) {
          debug('writeTarball name=%o headObject unexpected error: %o', name, convertedErr.message);
          uploadStream.emit('error', convertedErr);
          return;
        }

        debug('writeTarball name=%o not found → starting upload', name);
        const upload = new Upload({
          client: this.s3,
          params: {
            Bucket: this.config.bucket,
            Key: key,
            Body: uploadStream,
            ACL: this.tarballACL,
          },
        });

        const uploadPromise = upload.done().catch((err) => {
          debug('writeTarball name=%o upload failed: %o', name, err.message);
          const error = convertS3Error(err);
          uploadStream.emit('error', error);
          throw error;
        });

        uploadStream.emit('open');

        uploadStream.done = (): void => {
          const onEnd = async (): Promise<void> => {
            try {
              await uploadPromise;
              debug('writeTarball name=%o upload complete', name);
              uploadStream.emit('success');
            } catch {
              // error already emitted above
            }
          };
          if (streamEnded) {
            void onEnd();
          } else {
            uploadStream.on('end', () => void onEnd());
          }
        };

        uploadStream.abort = (): void => {
          debug('writeTarball name=%o aborting upload', name);
          try {
            void upload.abort();
          } catch (err: any) {
            uploadStream.emit('error', convertS3Error(err));
          }
          void this.s3
            .send(new DeleteObjectCommand({Bucket: this.config.bucket, Key: key}))
            .catch(() => {});
          debug('writeTarball name=%o abort cleanup sent', name);
        };
      }
    })();

    return uploadStream;
  }

  public readTarball(name: string): ReadTarball {
    const key = `${this.packagePath}/${name}`;
    debug('readTarball name=%o bucket=%o key=%o', name, this.config.bucket, key);
    const readTarballStream = new ReadTarball({});

    void (async (): Promise<void> => {
      try {
        const response = await this.s3.send(
          new GetObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
          })
        );

        const contentLength = response.ContentLength;
        debug('readTarball name=%o contentLength=%o', name, contentLength);
        if (contentLength) {
          readTarballStream.emit(HEADERS.CONTENT_LENGTH, contentLength);
        }
        readTarballStream.emit('open');

        const bodyStream = response.Body as Readable;
        bodyStream.on('error', (err) => {
          debug('readTarball name=%o stream error: %o', name, (err as any).message);
          readTarballStream.emit('error', convertS3Error(err as any));
        });
        bodyStream.pipe(readTarballStream);

        readTarballStream.abort = (): void => {
          debug('readTarball name=%o aborting stream', name);
          bodyStream.destroy();
        };
      } catch (err: any) {
        debug('readTarball name=%o failed: %o', name, err.message);
        readTarballStream.emit('error', convertS3Error(err));
      }
    })();

    return readTarballStream;
  }
}
