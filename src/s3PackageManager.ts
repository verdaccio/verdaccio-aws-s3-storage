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

    debug('constructor packageName: %o', packageName);

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
  }

  public updatePackage(
    name: string,
    updateHandler: Callback,
    onWrite: Callback,
    transformPackage: (pkg: Package) => Package,
    onEnd: Callback
  ): void {
    debug('updatePackage: %o', name);
    void (async (): Promise<void> => {
      try {
        const json = await this._getData();
        updateHandler(json, (err: any) => {
          if (err) {
            onEnd(err);
          } else {
            const transformedPackage = transformPackage(json);
            onWrite(name, transformedPackage, onEnd);
          }
        });
      } catch (err) {
        return onEnd(err);
      }
    })();
  }

  private async _getData(): Promise<Package> {
    debug('_getData');
    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: `${this.packagePath}/${pkgFileName}`,
      })
    );

    const bodyStr = (await response.Body?.transformToString()) ?? '';
    try {
      const data = JSON.parse(bodyStr);
      debug('_getData loaded: %o', data.name);
      return data;
    } catch (e) {
      debug('error parsing package data: %o', bodyStr);
      throw e;
    }
  }

  public deletePackage(fileName: string, callback: Callback): void {
    void (async (): Promise<void> => {
      try {
        await this.s3.send(
          new DeleteObjectCommand({
            Bucket: this.config.bucket,
            Key: `${this.packagePath}/${fileName}`,
          })
        );
        callback(null);
      } catch (err) {
        callback(err);
      }
    })();
  }

  public removePackage(callback: (err: Error | null) => void): void {
    void (async (): Promise<void> => {
      try {
        await deleteKeyPrefix(this.s3, {
          Bucket: this.config.bucket,
          Prefix: addTrailingSlash(this.packagePath),
        });
        callback(null);
      } catch (err: any) {
        if (is404Error(err)) {
          callback(null);
        } else {
          callback(err);
        }
      }
    })();
  }

  public createPackage(name: string, value: Package, callback: (err: Error | null) => void): void {
    debug('createPackage: %o', name);
    void (async (): Promise<void> => {
      try {
        await this.s3.send(
          new HeadObjectCommand({
            Bucket: this.config.bucket,
            Key: `${this.packagePath}/${pkgFileName}`,
          })
        );
        // Object exists — conflict
        debug('package already exists: %o', name);
        callback(create409Error());
      } catch (headErr: any) {
        const s3Err = convertS3Error(headErr);
        if (is404Error(s3Err)) {
          debug('package not found, creating new: %o', name);
          this.savePackage(name, value, callback);
        } else {
          callback(s3Err);
        }
      }
    })();
  }

  public savePackage(name: string, value: Package, callback: (err: Error | null) => void): void {
    debug('savePackage: %o', name);
    void (async (): Promise<void> => {
      try {
        await this.s3.send(
          new PutObjectCommand({
            Body: JSON.stringify(value, null, '  '),
            Bucket: this.config.bucket,
            Key: `${this.packagePath}/${pkgFileName}`,
          })
        );
        callback(null);
      } catch (err: any) {
        callback(err);
      }
    })();
  }

  public readPackage(name: string, callback: ReadPackageCallback): void {
    debug('readPackage: %o', name);
    void (async (): Promise<void> => {
      try {
        const data = await this._getData();
        callback(null, data);
      } catch (err: any) {
        callback(convertS3Error(err));
      }
    })();
  }

  public writeTarball(name: string): UploadTarball {
    debug('writeTarball: %o', name);
    const uploadStream = new UploadTarball({});

    let streamEnded = 0;
    uploadStream.on('end', () => {
      debug('writeTarball stream ended: %o', name);
      streamEnded = 1;
    });

    const key = `${this.packagePath}/${name}`;

    void (async (): Promise<void> => {
      try {
        // Check if file already exists
        await this.s3.send(
          new HeadObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
          })
        );
        // File exists — 409
        debug('writeTarball file already exists: %o', name);
        uploadStream.emit('error', create409Error());
      } catch (headErr: any) {
        const convertedErr = convertS3Error(headErr);
        if (!is404Error(convertedErr)) {
          uploadStream.emit('error', convertedErr);
          return;
        }

        // File doesn't exist, proceed with upload
        debug('writeTarball upload init');
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
          const error = convertS3Error(err);
          uploadStream.emit('error', error);
          throw error;
        });

        uploadStream.emit('open');

        uploadStream.done = (): void => {
          const onEnd = async (): Promise<void> => {
            try {
              await uploadPromise;
              debug('writeTarball emit success');
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
          debug('writeTarball abort');
          try {
            void upload.abort();
          } catch (err: any) {
            uploadStream.emit('error', convertS3Error(err));
          }
          void this.s3
            .send(new DeleteObjectCommand({Bucket: this.config.bucket, Key: key}))
            .catch(() => {});
        };
      }
    })();

    return uploadStream;
  }

  public readTarball(name: string): ReadTarball {
    debug('readTarball: %o', name);
    const readTarballStream = new ReadTarball({});

    void (async (): Promise<void> => {
      try {
        const response = await this.s3.send(
          new GetObjectCommand({
            Bucket: this.config.bucket,
            Key: `${this.packagePath}/${name}`,
          })
        );

        const contentLength = response.ContentLength;
        if (contentLength) {
          readTarballStream.emit(HEADERS.CONTENT_LENGTH, contentLength);
        }
        readTarballStream.emit('open');

        const bodyStream = response.Body as Readable;
        bodyStream.on('error', (err) => {
          readTarballStream.emit('error', convertS3Error(err as any));
          debug('readTarball error: %o', (err as any).message);
        });
        bodyStream.pipe(readTarballStream);

        readTarballStream.abort = (): void => {
          debug('readTarball abort');
          bodyStream.destroy();
        };
      } catch (err: any) {
        readTarballStream.emit('error', convertS3Error(err));
      }
    })();

    return readTarballStream;
  }
}
