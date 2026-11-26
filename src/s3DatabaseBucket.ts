import type {Callback, Logger, Token, TokenFilter} from '@verdaccio/types';

import type {S3Config} from '../types';

import {GetObjectCommand, PutObjectCommand} from '@aws-sdk/client-s3';
import type {S3Client} from '@aws-sdk/client-s3';
import debugCore from 'debug';

const debug = debugCore('verdaccio:plugin:aws-s3-storage:database:bucket');

const LOCAL_STORAGE_KEY = 'verdaccio-s3-db.json';
const MAX_ATTEMPTS = 5;

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
  // Changes to the database run one at a time within this process.
  private _queue: Promise<void> = Promise.resolve();

  public constructor(config: S3Config, logger: Logger, s3: S3Client) {
    this.logger = logger;
    this.config = config;
    this.s3 = s3;

    this._localData = {secret: '', list: [], tokens: []};
  }

  public async init(): Promise<void> {
    debug('init: verifying connectivity');
    this.logger.trace('aws-s3-storage: [init] verifying S3 connectivity');
    try {
      this._localData = await this._getData();
    } catch (err: any) {
      // Only a missing file may be replaced; any other failure would wipe the secret and tokens.
      const notFound =
        err?.name === 'NoSuchKey' ||
        err?.name === 'NotFound' ||
        err?.$metadata?.httpStatusCode === 404;
      if (!notFound) {
        debug('init: cannot read database: %o', err?.message);
        this.logger.error(
          {error: err?.message},
          'aws-s3-storage: [init] cannot read the database, refusing to overwrite it: @{error}'
        );
        throw err;
      }
      debug('init: database not found, creating a new one');
      this.logger.warn('aws-s3-storage: [init] database not found, creating a new one');
      await new Promise<void>((resolve, reject): void => {
        this._putData((putErr) => (putErr ? reject(putErr) : resolve()));
      });
    }
    debug('init: connectivity verified');
    this.logger.trace('aws-s3-storage: [init] connectivity verified');
  }

  // Secret management

  public async getSecret(): Promise<string> {
    return Promise.resolve(this._localData.secret);
  }

  public async setSecret(secret: string): Promise<void> {
    await this._mutate((data) => {
      if (data.secret === secret) return false;
      data.secret = secret;
      return true;
    });
  }

  // List of Packages

  // Other instances may have changed the list, so it is read from S3 on every call.
  public get(callback?: Callback): string[] | void {
    if (typeof callback !== 'function') {
      return this._localData.list;
    }
    void this._readList().then((list) => callback(null, list));
  }

  public add(name: string, callback: Callback): void {
    this.logger.debug({name}, 's3: [add] private package @{name}');
    this._mutate((data) => {
      if (data.list.includes(name)) return false;
      data.list.push(name);
      this.logger.trace({name}, 's3: [add] @{name} has been added');
      return true;
    }).then(
      () => callback(null),
      (err) => callback(err)
    );
  }

  public remove(name: string, callback: Callback): void {
    this.logger.debug({name}, 's3: [remove] private package @{name}');
    this._mutate((data) => {
      if (!data.list.includes(name)) return false;
      data.list = data.list.filter((pkg) => pkg !== name);
      this.logger.trace({name}, 's3: [remove] @{name} has been removed');
      return true;
    }).then(
      () => callback(null),
      (err) => callback(err)
    );
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
          const list = await this._readList();
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
          this.logger.trace({err}, 'aws-s3-storage: [search] error during iteration');
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
    if (this._localData.tokens.some((t) => t.user === token.user && t.key === token.key)) {
      throw new Error('Token already exists');
    }
    this._localData.tokens.push(token);
    this._putData();
  }

  public async deleteToken(user: string, tokenKey: string): Promise<void> {
    this._localData.tokens = this._localData.tokens.filter(
      (token) => token.user !== user || token.key !== tokenKey
    );
    this._putData();
  }

  public async readTokens(filter: TokenFilter): Promise<Token[]> {
    return this._localData.tokens.filter((token) => token.user === filter.user);
  }

  // Bucket operations

  private _databaseKey(): string {
    return `${this.config.keyPrefix}${LOCAL_STORAGE_KEY}`;
  }

  private async _readDatabase(): Promise<{data: LocalStorage; etag?: string}> {
    const response = await this.s3.send(
      new GetObjectCommand({Bucket: this.config.bucket, Key: this._databaseKey()})
    );
    const bodyStr = (await response.Body?.transformToString()) ?? '';
    return {data: JSON.parse(bodyStr), etag: response.ETag};
  }

  private async _writeDatabase(data: LocalStorage, etag?: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Body: JSON.stringify(data, null, '  '),
        Bucket: this.config.bucket,
        Key: this._databaseKey(),
        IfMatch: this.config.conditionalWrites === true ? etag : undefined,
      })
    );
  }

  /**
   * Reads the database from S3, applies `apply` to that copy and writes it back. `apply`
   * returns false when there is nothing to write. Without this, every instance wrote back its
   * own in-memory copy and dropped the changes made by the others. With `conditionalWrites`,
   * a write that lost the race to another instance fails with 412 and the change is applied
   * again to a fresh copy.
   */
  private _mutate(apply: (data: LocalStorage) => boolean): Promise<void> {
    const run = this._queue.then(async (): Promise<void> => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const {data, etag} = await this._readDatabase();
        if (!apply(data)) {
          this._localData = data;
          return;
        }
        try {
          await this._writeDatabase(data, etag);
          this._localData = data;
          return;
        } catch (err: any) {
          if (err?.$metadata?.httpStatusCode !== 412) throw err;
          debug('_mutate: write conflict, attempt %d', attempt);
          this.logger.warn(
            {attempt},
            'aws-s3-storage: [db] database changed by another instance, retrying (attempt @{attempt})'
          );
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 150));
          }
        }
      }
      throw new Error(
        `aws-s3-storage: [db] ${LOCAL_STORAGE_KEY} kept changing under this write, gave up after ${MAX_ATTEMPTS} attempts`
      );
    });
    this._queue = run.catch(() => undefined);
    return run;
  }

  // The list from S3; the in-memory copy if S3 cannot be read, so the web UI keeps working.
  private async _readList(): Promise<string[]> {
    try {
      const {data} = await this._readDatabase();
      this._localData = data;
      return data.list;
    } catch (err: any) {
      this.logger.warn(
        {error: err?.message},
        'aws-s3-storage: [db] cannot read the database, serving the in-memory list: @{error}'
      );
      return this._localData.list;
    }
  }

  private async _getData(): Promise<LocalStorage> {
    const key = `${this.config.keyPrefix}${LOCAL_STORAGE_KEY}`;
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
      debug('_getData loaded package=%o count=%d', data.name, data.list.length);
      this.logger.trace(
        {packageName: data.name, count: data.list.length},
        'aws-s3-storage: [_getData] loaded package=@{packageName} with @{count} packages'
      );
      return data;
    } catch (err: any) {
      debug('_getData JSON parse error for key=%o bodyLength=%d', key, bodyStr.length);
      this.logger.trace(
        {key, bodyLength: bodyStr.length},
        'aws-s3-storage: [_getData] JSON parse error key=@{key} bodyLength=@{bodyLength}'
      );
      throw err;
    }
  }

  private _putData(callback?: Callback): void {
    const key = `${this.config.keyPrefix}${LOCAL_STORAGE_KEY}`;
    debug('_putData bucket=%o key=%o', this.config.bucket, key);
    this.logger.trace(
      {bucket: this.config.bucket, key},
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
        this.logger.trace({key}, 'aws-s3-storage: [_putData] written to key=@{key}');
        if (callback) callback(null);
      } catch (err: any) {
        debug('_putData failed: %o', err.message);
        this.logger.trace(
          {error: err.message},
          'aws-s3-storage: [_putData] write failed: @{error}'
        );
        if (callback) callback(err);
      }
    })();
  }
}
