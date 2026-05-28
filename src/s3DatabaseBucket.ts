import { GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import debugCore from 'debug';

import type { Callback, Logger, Token, TokenFilter } from '@verdaccio/types';

import type { S3Config } from '../types';

const debug = debugCore('verdaccio:plugin:aws-s3-storage:database:bucket');

const LOCAL_STORAGE_KEY = 'verdaccio-s3-db.json';

type LocalStorage = {
  secret: string;
  list: string[];
  tokens: Token[];
};

export default class S3DatabaseBucket {
  public logger: Logger;
  public config: S3Config;
  private s3: S3Client;
  private _localData: LocalStorage;

  public constructor(config: S3Config, logger: Logger, s3: S3Client) {
    this.logger = logger;
    this.config = config;
    this.s3 = s3;

    this._localData = { secret: '', list: [], tokens: [] };
  }

  public async init(): Promise<void> {
    debug('init: verifying connectivity');
    this.logger.trace('aws-s3-storage: [init] verifying S3 connectivity');
    try {
      this._localData = await this._getData();
    } catch {
      await this._createData();
      this._putData();
    }
    debug('init: connectivity verified');
    this.logger.trace('aws-s3-storage: [init] connectivity verified');
  }

  // Secret management

  public async getSecret(): Promise<string> {
    return Promise.resolve(this._localData.secret);
  }

  public async setSecret(secret: string): Promise<void> {
    this._localData.secret = secret;
    this._putData();
  }

  // List of Packages

  public get(): string[] {
    return this._localData.list;
  }

  public add(name: string, callback: Callback): void {
    this.logger.debug({ name }, 's3: [add] private package @{name}');
    if (this._localData.list.includes(name)) {
      callback(null);
      return;
    }
    this._localData.list.push(name);
    this.logger.trace({ name }, 's3: [add] @{name} has been added');
    this._putData(callback);
  }

  public remove(name: string, callback: Callback): void {
    this.logger.debug({ name }, 's3: [remove] private package @{name}');
    if (!this._localData.list.includes(name)) {
      callback(null);
      return;
    }
    this._localData.list = this._localData.list.filter(pkg => pkg !== name);
    this.logger.trace({ name }, 's3: [remove] @{name} has been removed');
    this._putData(callback);
  }

  /**
 * Search packages. Verdaccio 6/7 calls this with callback pattern: search(onPackage, onEnd).
 * Newer versions may call with search(query): Promise<SearchItem[]>.
 * We support both signatures.
 */
  public search(...args: any[]): any {
    // Callback pattern: search(onPackage, onEnd)
    if (typeof args[0] === 'function') {
      const onPackage = args[0] as (item: any, cb: any) => void;
      const onEnd = args[1] as () => void;
      debug('search (callback): iterating packages from DynamoDB');
      this.logger.trace('aws-s3-storage: [search] callback pattern, iterating packages');
      void (async (): Promise<void> => {
        try {
          const list = this.get();
          debug('search: found %d packages', list.length);
          for (const item of list) {
            await new Promise<void>((resolve): void => {
              onPackage(
                {
                  name: item,
                  path: item,
                  time: Date.now(),
                },
                resolve
              );
            });
          }
          onEnd();
        } catch (err) {
          debug('search error: %o', err);
          this.logger.trace({ err }, 'aws-s3-storage: [search] error during iteration');
          onEnd();
        }
      })();
      return;
    }

    // Promise pattern: search(query): Promise<SearchItem[]>
    debug('search (promise): returning empty results (delegated to uplinks)');
    this.logger.trace('aws-s3-storage: [search] promise pattern, returning empty results');
    return Promise.resolve([]);
  }

  // Token management

  public async saveToken(token: Token): Promise<void> {
    if (this._localData.tokens.some(t => t.user === token.user && t.key === token.key)) {
      throw new Error('Token already exists');
    }
    this._localData.tokens.push(token);
    this._putData();
  }

  public async deleteToken(user: string, tokenKey: string): Promise<void> {
    this._localData.tokens = this._localData.tokens.filter(token => token.user !== user || token.key !== tokenKey);
    this._putData();
  }

  public async readTokens(filter: TokenFilter): Promise<Token[]> {
    return this._localData.tokens.filter(token => token.user === filter.user);
  }

  // Bucket operations

  public async _createData(): Promise<void> {
    const key = `${this.config.keyPrefix}${LOCAL_STORAGE_KEY}`;
    debug('createData bucket=%o key=%o', this.config.bucket, key);
    this.logger.trace(
      { bucket: this.config.bucket, key },
      'aws-s3-storage: [_createData] creating bucket=@{bucket} key=@{key}'
    );
    void (async (): Promise<void> => {
      try {
        await this.s3.send(
          new HeadObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
          })
        );
        debug('createData bucket=%o key=%o created', this.config.bucket, key);
        this.logger.trace(
          { bucket: this.config.bucket, key },
          'aws-s3-storage: [_createData] created bucket=@{bucket} key=@{key}'
        );
      } catch (err: any) {
        debug('_createData failed: %o', err.message);
        this.logger.trace(
          { error: err.message },
          'aws-s3-storage: [_createData] write failed: @{error}'
        );
        throw err;
      }
    })();
  }

  private async _getData(): Promise<LocalStorage> {
    const key = `${this.config.keyPrefix}${LOCAL_STORAGE_KEY}`;
    debug('_getData bucket=%o key=%o', this.config.bucket, key);
    this.logger.trace(
      { bucket: this.config.bucket, key },
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
        '_getData loaded package=%o count=%d',
        data.name,
        data.list.length
      );
      this.logger.trace(
        { packageName: data.name, count: data.list.length },
        'aws-s3-storage: [_getData] loaded package=@{packageName} with @{count} packages'
      );
      return data;
    } catch (err: any) {
      debug('_getData JSON parse error for key=%o bodyLength=%d', key, bodyStr.length);
      this.logger.trace(
        { key, bodyLength: bodyStr.length },
        'aws-s3-storage: [_getData] JSON parse error key=@{key} bodyLength=@{bodyLength}'
      );
      throw err;
    }
  }

  private _putData(callback?: Callback): void {
    const key = `${this.config.keyPrefix}${LOCAL_STORAGE_KEY}`;
    debug('_putData bucket=%o key=%o', this.config.bucket, key);
    this.logger.trace(
      { bucket: this.config.bucket, key },
      'aws-s3-storage: [_putData] writing bucket=@{bucket} key=@{key}'
    );
    const data = this._localData;
    void (async (): Promise<void> => {
      try {
        await this.s3.send(
          new PutObjectCommand({
            Body: JSON.stringify(data, null, '  '),
            Bucket: this.config.bucket,
            Key: key,
          })
        );
        debug('_putData bucket=%o key=%o saved', this.config.bucket, key);
        this.logger.trace(
          { key },
          'aws-s3-storage: [_putData] written to key=@{key}'
        );
        if (callback) callback(null);
      } catch (err: any) {
        debug('_putData failed: %o', err.message);
        this.logger.trace(
          { error: err.message },
          'aws-s3-storage: [_putData] write failed: @{error}'
        );
        if (callback) callback(err);
      }
    })();
  }
}
