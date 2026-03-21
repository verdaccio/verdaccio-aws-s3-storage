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
    this.logger.trace(
      {packageName, packagePath: this.packagePath, bucket: config.bucket, acl: this.tarballACL},
      'aws-s3-storage: [S3PackageManager] init package=@{packageName} path=@{packagePath} bucket=@{bucket} acl=@{acl}'
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
    this.logger.trace(
      {name, packagePath: this.packagePath},
      'aws-s3-storage: [updatePackage] name=@{name} path=@{packagePath}'
    );
    void (async (): Promise<void> => {
      try {
        const json = await this._getData();
        debug('updatePackage name=%o loaded, calling updateHandler', name);
        this.logger.trace(
          {name},
          'aws-s3-storage: [updatePackage] data loaded for name=@{name}, running updateHandler'
        );
        updateHandler(json, (err: any) => {
          if (err) {
            debug('updatePackage name=%o updateHandler error: %o', name, err);
            this.logger.trace(
              {name, err},
              'aws-s3-storage: [updatePackage] updateHandler error for name=@{name}'
            );
            onEnd(err);
          } else {
            const transformedPackage = transformPackage(json);
            debug('updatePackage name=%o transformed, calling onWrite', name);
            this.logger.trace(
              {name},
              'aws-s3-storage: [updatePackage] transformed name=@{name}, writing'
            );
            onWrite(name, transformedPackage, onEnd);
          }
        });
      } catch (err) {
        debug('updatePackage name=%o getData failed: %o', name, err);
        this.logger.trace(
          {name, err},
          'aws-s3-storage: [updatePackage] getData failed for name=@{name}'
        );
        return onEnd(err);
      }
    })();
  }

  private async _getData(): Promise<Package> {
    const key = `${this.packagePath}/${pkgFileName}`;
    debug('_getData bucket=%o key=%o', this.config.bucket, key);
    this.logger.trace(
      {bucket: this.config.bucket, key},
      'aws-s3-storage: [_getData] fetching bucket=@{bucket} key=@{key}'
    );
    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      })
    );

    const bodyStr = (await response.Body?.transformToString()) ?? '';
    try {
      const data = JSON.parse(bodyStr);
      debug(
        '_getData loaded package=%o versions=%d',
        data.name,
        Object.keys(data.versions || {}).length
      );
      this.logger.trace(
        {packageName: data.name, versions: Object.keys(data.versions || {}).length},
        'aws-s3-storage: [_getData] loaded package=@{packageName} with @{versions} versions'
      );
      return data;
    } catch (e) {
      debug('_getData JSON parse error for key=%o bodyLength=%d', key, bodyStr.length);
      this.logger.trace(
        {key, bodyLength: bodyStr.length},
        'aws-s3-storage: [_getData] JSON parse error key=@{key} bodyLength=@{bodyLength}'
      );
      throw e;
    }
  }

  public deletePackage(fileName: string, callback: Callback): void {
    const key = `${this.packagePath}/${fileName}`;
    debug('deletePackage bucket=%o key=%o', this.config.bucket, key);
    this.logger.trace(
      {bucket: this.config.bucket, key},
      'aws-s3-storage: [deletePackage] deleting bucket=@{bucket} key=@{key}'
    );
    void (async (): Promise<void> => {
      try {
        await this.s3.send(
          new DeleteObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
          })
        );
        debug('deletePackage key=%o deleted', key);
        this.logger.trace({key}, 'aws-s3-storage: [deletePackage] deleted key=@{key}');
        callback(null);
      } catch (err) {
        debug('deletePackage key=%o failed: %o', key, err);
        this.logger.trace({key, err}, 'aws-s3-storage: [deletePackage] failed key=@{key}');
        callback(err);
      }
    })();
  }

  public removePackage(callback: (err: Error | null) => void): void {
    const prefix = addTrailingSlash(this.packagePath);
    debug('removePackage bucket=%o prefix=%o', this.config.bucket, prefix);
    this.logger.trace(
      {bucket: this.config.bucket, prefix},
      'aws-s3-storage: [removePackage] removing all objects bucket=@{bucket} prefix=@{prefix}'
    );
    void (async (): Promise<void> => {
      try {
        await deleteKeyPrefix(this.s3, {
          Bucket: this.config.bucket,
          Prefix: prefix,
        });
        debug('removePackage prefix=%o removed', prefix);
        this.logger.trace({prefix}, 'aws-s3-storage: [removePackage] removed prefix=@{prefix}');
        callback(null);
      } catch (err: any) {
        if (is404Error(err)) {
          debug('removePackage prefix=%o already empty (404), ignoring', prefix);
          this.logger.trace(
            {prefix},
            'aws-s3-storage: [removePackage] prefix=@{prefix} already empty, ignoring 404'
          );
          callback(null);
        } else {
          debug('removePackage prefix=%o failed: %o', prefix, err);
          this.logger.trace(
            {prefix, err},
            'aws-s3-storage: [removePackage] failed prefix=@{prefix}'
          );
          callback(err);
        }
      }
    })();
  }

  public createPackage(name: string, value: Package, callback: (err: Error | null) => void): void {
    const key = `${this.packagePath}/${pkgFileName}`;
    debug('createPackage name=%o bucket=%o key=%o', name, this.config.bucket, key);
    this.logger.trace(
      {name, bucket: this.config.bucket, key},
      'aws-s3-storage: [createPackage] checking if name=@{name} exists at key=@{key}'
    );
    void (async (): Promise<void> => {
      try {
        await this.s3.send(
          new HeadObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
          })
        );
        debug('createPackage name=%o already exists → 409', name);
        this.logger.trace(
          {name, key},
          'aws-s3-storage: [createPackage] name=@{name} already exists, returning 409'
        );
        callback(create409Error());
      } catch (headErr: any) {
        const s3Err = convertS3Error(headErr);
        if (is404Error(s3Err)) {
          debug('createPackage name=%o not found → creating', name);
          this.logger.trace(
            {name, key},
            'aws-s3-storage: [createPackage] name=@{name} not found, saving new package'
          );
          this.savePackage(name, value, callback);
        } else {
          debug('createPackage name=%o headObject error: %o', name, s3Err.message);
          this.logger.trace(
            {name, error: s3Err.message},
            'aws-s3-storage: [createPackage] headObject error for name=@{name}: @{error}'
          );
          callback(s3Err);
        }
      }
    })();
  }

  public savePackage(name: string, value: Package, callback: (err: Error | null) => void): void {
    const key = `${this.packagePath}/${pkgFileName}`;
    debug('savePackage name=%o bucket=%o key=%o', name, this.config.bucket, key);
    this.logger.trace(
      {name, bucket: this.config.bucket, key},
      'aws-s3-storage: [savePackage] writing name=@{name} to bucket=@{bucket} key=@{key}'
    );
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
        this.logger.trace(
          {name, key},
          'aws-s3-storage: [savePackage] name=@{name} written to key=@{key}'
        );
        callback(null);
      } catch (err: any) {
        debug('savePackage name=%o failed: %o', name, err.message);
        this.logger.trace(
          {name, error: err.message},
          'aws-s3-storage: [savePackage] name=@{name} write failed: @{error}'
        );
        callback(err);
      }
    })();
  }

  public readPackage(name: string, callback: ReadPackageCallback): void {
    debug('readPackage name=%o path=%o', name, this.packagePath);
    this.logger.trace(
      {name, packagePath: this.packagePath},
      'aws-s3-storage: [readPackage] reading name=@{name} from path=@{packagePath}'
    );
    void (async (): Promise<void> => {
      try {
        const data = await this._getData();
        debug('readPackage name=%o success', name);
        this.logger.trace({name}, 'aws-s3-storage: [readPackage] name=@{name} read successfully');
        callback(null, data);
      } catch (err: any) {
        debug('readPackage name=%o failed: %o', name, err.message);
        this.logger.trace(
          {name, error: err.message},
          'aws-s3-storage: [readPackage] name=@{name} failed: @{error}'
        );
        callback(convertS3Error(err));
      }
    })();
  }

  public writeTarball(name: string): UploadTarball {
    const key = `${this.packagePath}/${name}`;
    debug(
      'writeTarball name=%o bucket=%o key=%o acl=%o',
      name,
      this.config.bucket,
      key,
      this.tarballACL
    );
    this.logger.trace(
      {name, bucket: this.config.bucket, key, acl: this.tarballACL},
      'aws-s3-storage: [writeTarball] starting upload name=@{name} bucket=@{bucket} key=@{key} acl=@{acl}'
    );
    const uploadStream = new UploadTarball({});

    let streamEnded = 0;
    uploadStream.on('end', () => {
      debug('writeTarball name=%o stream ended', name);
      this.logger.trace({name}, 'aws-s3-storage: [writeTarball] stream ended for name=@{name}');
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
        this.logger.trace(
          {name, key},
          'aws-s3-storage: [writeTarball] name=@{name} already exists at key=@{key}, emitting 409'
        );
        uploadStream.emit('error', create409Error());
      } catch (headErr: any) {
        const convertedErr = convertS3Error(headErr);
        if (!is404Error(convertedErr)) {
          debug('writeTarball name=%o headObject unexpected error: %o', name, convertedErr.message);
          this.logger.trace(
            {name, error: convertedErr.message},
            'aws-s3-storage: [writeTarball] headObject unexpected error for name=@{name}: @{error}'
          );
          uploadStream.emit('error', convertedErr);
          return;
        }

        debug('writeTarball name=%o not found → starting upload', name);
        this.logger.trace(
          {name, key},
          'aws-s3-storage: [writeTarball] name=@{name} not found, initiating multipart upload to key=@{key}'
        );
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
          this.logger.trace(
            {name, error: err.message},
            'aws-s3-storage: [writeTarball] upload failed for name=@{name}: @{error}'
          );
          const error = convertS3Error(err);
          uploadStream.emit('error', error);
          throw error;
        });

        uploadStream.emit('open');
        this.logger.trace({name}, 'aws-s3-storage: [writeTarball] emitted open for name=@{name}');

        uploadStream.done = (): void => {
          const onEnd = async (): Promise<void> => {
            try {
              await uploadPromise;
              debug('writeTarball name=%o upload complete', name);
              this.logger.trace(
                {name, key},
                'aws-s3-storage: [writeTarball] upload complete name=@{name} key=@{key}'
              );
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
          this.logger.trace(
            {name, key},
            'aws-s3-storage: [writeTarball] aborting upload name=@{name}, cleaning up key=@{key}'
          );
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
    this.logger.trace(
      {name, bucket: this.config.bucket, key},
      'aws-s3-storage: [readTarball] reading name=@{name} from bucket=@{bucket} key=@{key}'
    );
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
        this.logger.trace(
          {name, contentLength},
          'aws-s3-storage: [readTarball] name=@{name} fetched, contentLength=@{contentLength}'
        );
        if (contentLength) {
          readTarballStream.emit(HEADERS.CONTENT_LENGTH, contentLength);
        }
        readTarballStream.emit('open');

        const bodyStream = response.Body as Readable;
        bodyStream.on('error', (err) => {
          debug('readTarball name=%o stream error: %o', name, (err as any).message);
          this.logger.trace(
            {name, error: (err as any).message},
            'aws-s3-storage: [readTarball] stream error for name=@{name}: @{error}'
          );
          readTarballStream.emit('error', convertS3Error(err as any));
        });
        bodyStream.pipe(readTarballStream);
        this.logger.trace({name}, 'aws-s3-storage: [readTarball] piping stream for name=@{name}');

        readTarballStream.abort = (): void => {
          debug('readTarball name=%o aborting stream', name);
          this.logger.trace(
            {name},
            'aws-s3-storage: [readTarball] aborting stream for name=@{name}'
          );
          bodyStream.destroy();
        };
      } catch (err: any) {
        debug('readTarball name=%o failed: %o', name, err.message);
        this.logger.trace(
          {name, error: err.message},
          'aws-s3-storage: [readTarball] failed for name=@{name}: @{error}'
        );
        readTarballStream.emit('error', convertS3Error(err));
      }
    })();

    return readTarballStream;
  }
}
