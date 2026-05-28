import type { S3Client } from '@aws-sdk/client-s3';
import debugCore from 'debug';

import type { searchUtils } from '@verdaccio/core';
import type { Callback, Config, Logger, Token, TokenFilter } from '@verdaccio/types';

import type { S3Config } from '../types';
import addTrailingSlash from './addTrailingSlash';
import { createS3Client } from './s3Client';
import S3DatabaseBucket from './s3DatabaseBucket';
import S3DatabaseDynamo from './s3DatabaseDynamo';
import S3PackageManager from './s3PackageManager';
import setConfigValue from './setConfigValue';

const debug = debugCore('verdaccio:plugin:aws-s3-storage:database');

export default class S3Database {
  public logger: Logger;
  public config: S3Config;
  private s3: S3Client;
  private database: S3DatabaseBucket | S3DatabaseDynamo;

  public constructor(config: Config, options: { logger: Logger; config: Config }) {
    this.logger = options.logger;
    if (!config) {
      throw new Error('s3 storage missing config. Add `store.s3-storage` to your config file');
    }
    // verdaccio 7+ passes plugin config directly, older versions nest it under config.store
    const pluginConfig = config.store?.['aws-s3-storage'] ?? {};
    this.config = Object.assign({}, config, pluginConfig) as S3Config;

    if (!this.config.bucket) {
      throw new Error('s3 storage requires a bucket');
    }

    if (!this.config.dynamoTableName) {
      throw new Error('s3 storage requires a dynamoTableName');
    }

    this.config.bucket = setConfigValue(this.config.bucket);
    this.config.keyPrefix = setConfigValue(this.config.keyPrefix);
    this.config.endpoint = setConfigValue(this.config.endpoint);
    this.config.region = setConfigValue(this.config.region);
    this.config.accessKeyId = setConfigValue(this.config.accessKeyId);
    this.config.secretAccessKey = setConfigValue(this.config.secretAccessKey);
    this.config.sessionToken = setConfigValue(this.config.sessionToken);
    this.config.proxy = setConfigValue(this.config.proxy);
    this.config.dynamoTableName = setConfigValue(this.config.dynamoTableName);
    this.config.dynamoEndpoint = setConfigValue(this.config.dynamoEndpoint);
    this.config.dynamoRegion = setConfigValue(this.config.dynamoRegion);

    const configKeyPrefix = this.config.keyPrefix;
    this.config.keyPrefix = addTrailingSlash(configKeyPrefix);

    debug(
      'initialized bucket=%o keyPrefix=%o region=%o dynamoTable=%o',
      this.config.bucket,
      this.config.keyPrefix,
      this.config.region,
      this.config.dynamoTableName
    );
    this.logger.trace(
      {
        bucket: this.config.bucket,
        keyPrefix: this.config.keyPrefix,
        region: this.config.region,
        dynamoTable: this.config.dynamoTableName,
      },
      'aws-s3-storage: plugin initialized bucket=@{bucket} keyPrefix=@{keyPrefix} region=@{region} dynamoTable=@{dynamoTable}'
    );

    this.s3 = createS3Client(this.config);

    if (this.config.dynamoTableName === 'none') {
      this.database = new S3DatabaseBucket(this.config, this.logger, this.s3)
    } else {
      this.database = new S3DatabaseDynamo(this.config, this.logger, this.s3);
    }
  }

  public async init(): Promise<void> {
    await this.database.init();
  }

  public async getSecret(): Promise<string> {
    return this.database.getSecret();
  }

  public async setSecret(secret: string): Promise<void> {
    await this.database.setSecret(secret);
  }

  public add(name: string, callback: Callback): void {
    this.database.add(name, callback);
  }

  public remove(name: string, callback: Callback): void {
    this.database.remove(name, callback);
  }

  public get(callback: Callback): void {
    this.database.get(callback);
  }

  /**
   * Search packages. Verdaccio 6/7 calls this with callback pattern: search(onPackage, onEnd).
   * Newer versions may call with search(query): Promise<SearchItem[]>.
   * We support both signatures.
   */
  public search(...args) {
    return this.database.search(...args);
  }

  public async filterByQuery(
    _results: searchUtils.SearchItemPkg[],
    _query: searchUtils.SearchQuery
  ): Promise<searchUtils.SearchItemPkg[]> {
    return _results;
  }

  public async getScore(_pkg: searchUtils.SearchItemPkg): Promise<searchUtils.Score> {
    return {
      final: 1,
      detail: {
        quality: 1,
        popularity: 1,
        maintenance: 1,
      },
    };
  }

  public getPackageStorage(packageName: string): S3PackageManager {
    debug('getPackageStorage package=%o bucket=%o', packageName, this.config.bucket);
    this.logger.trace(
      { packageName, bucket: this.config.bucket },
      'aws-s3-storage: [getPackageStorage] creating storage for package=@{packageName} bucket=@{bucket}'
    );
    return new S3PackageManager(this.config, packageName, this.logger, this.s3);
  }

  public async saveToken(token: Token): Promise<void> {
    await this.database.saveToken(token);
  }

  public async deleteToken(user: string, tokenKey: string): Promise<void> {
    await this.database.deleteToken(user, tokenKey);
  }

  public async readTokens(filter: TokenFilter): Promise<Token[]> {
    return this.database.readTokens(filter);
  }
}
