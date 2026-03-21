import {GetCommand, PutCommand, DeleteCommand, QueryCommand} from '@aws-sdk/lib-dynamodb';
import type {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import type {S3Client} from '@aws-sdk/client-s3';
import debugCore from 'debug';

import type {searchUtils} from '@verdaccio/core';
import type {Callback, Config, Logger, Token, TokenFilter} from '@verdaccio/types';

import type {S3Config} from '../types';
import addTrailingSlash from './addTrailingSlash';
import {createDynamoClient} from './dynamoClient';
import {createS3Client} from './s3Client';
import S3PackageManager from './s3PackageManager';
import setConfigValue from './setConfigValue';

const debug = debugCore('verdaccio:plugin:aws-s3-storage:database');

export default class S3Database {
  public logger: Logger;
  public config: S3Config;
  private s3: S3Client;
  private dynamo: DynamoDBDocumentClient;
  private tableName: string;

  public constructor(config: Config, options: {logger: Logger; config: Config}) {
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
    this.tableName = this.config.dynamoTableName;

    debug(
      'initialized bucket=%o keyPrefix=%o region=%o dynamoTable=%o',
      this.config.bucket,
      this.config.keyPrefix,
      this.config.region,
      this.tableName
    );
    this.logger.trace(
      {
        bucket: this.config.bucket,
        keyPrefix: this.config.keyPrefix,
        region: this.config.region,
        dynamoTable: this.tableName,
      },
      'aws-s3-storage: plugin initialized bucket=@{bucket} keyPrefix=@{keyPrefix} region=@{region} dynamoTable=@{dynamoTable}'
    );

    this.s3 = createS3Client(this.config);
    this.dynamo = createDynamoClient(this.config);
  }

  public async init(): Promise<void> {
    debug('init: verifying connectivity');
    this.logger.trace('aws-s3-storage: [init] verifying DynamoDB connectivity');
    // Verify DynamoDB table is accessible by reading the secret
    await this.getSecret();
    debug('init: connectivity verified');
    this.logger.trace('aws-s3-storage: [init] connectivity verified');
  }

  public async getSecret(): Promise<string> {
    debug('getSecret from table=%o', this.tableName);
    this.logger.trace(
      {table: this.tableName},
      'aws-s3-storage: [getSecret] reading from table=@{table}'
    );
    try {
      const result = await this.dynamo.send(
        new GetCommand({
          TableName: this.tableName,
          Key: {pk: 'CONFIG', sk: 'SECRET'},
        })
      );
      const hasSecret = !!result.Item?.secret;
      debug('getSecret found=%o', hasSecret);
      this.logger.trace({found: hasSecret}, 'aws-s3-storage: [getSecret] found=@{found}');
      return result.Item?.secret ?? '';
    } catch (err) {
      debug('getSecret failed: %o', err);
      this.logger.trace({err}, 'aws-s3-storage: [getSecret] error, returning empty secret');
      return '';
    }
  }

  public async setSecret(secret: string): Promise<void> {
    debug('setSecret table=%o', this.tableName);
    this.logger.trace(
      {table: this.tableName},
      'aws-s3-storage: [setSecret] writing to table=@{table}'
    );
    await this.dynamo.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {pk: 'CONFIG', sk: 'SECRET', secret},
      })
    );
    debug('setSecret stored successfully');
    this.logger.trace('aws-s3-storage: [setSecret] stored successfully');
  }

  public add(name: string, callback: Callback): void {
    debug('add package=%o table=%o', name, this.tableName);
    this.logger.trace(
      {name, table: this.tableName},
      'aws-s3-storage: [add] adding package=@{name} to table=@{table}'
    );
    void (async (): Promise<void> => {
      try {
        await this.dynamo.send(
          new PutCommand({
            TableName: this.tableName,
            Item: {pk: 'PACKAGE', sk: name, name},
          })
        );
        debug('add package=%o success', name);
        this.logger.trace({name}, 'aws-s3-storage: [add] package=@{name} added successfully');
        callback(null);
      } catch (err) {
        debug('add package=%o failed: %o', name, err);
        this.logger.trace({name, err}, 'aws-s3-storage: [add] package=@{name} failed');
        callback(err);
      }
    })();
  }

  public remove(name: string, callback: Callback): void {
    debug('remove package=%o table=%o', name, this.tableName);
    this.logger.trace(
      {name, table: this.tableName},
      'aws-s3-storage: [remove] removing package=@{name} from table=@{table}'
    );
    void (async (): Promise<void> => {
      try {
        await this.dynamo.send(
          new DeleteCommand({
            TableName: this.tableName,
            Key: {pk: 'PACKAGE', sk: name},
          })
        );
        debug('remove package=%o success', name);
        this.logger.trace({name}, 'aws-s3-storage: [remove] package=@{name} removed successfully');
        callback(null);
      } catch (err) {
        debug('remove package=%o failed: %o', name, err);
        this.logger.trace({name, err}, 'aws-s3-storage: [remove] package=@{name} failed');
        callback(err);
      }
    })();
  }

  public get(callback: Callback): void {
    debug('get all packages from table=%o', this.tableName);
    this.logger.trace(
      {table: this.tableName},
      'aws-s3-storage: [get] querying all packages from table=@{table}'
    );
    void (async (): Promise<void> => {
      try {
        const result = await this.dynamo.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'pk = :pk',
            ExpressionAttributeValues: {':pk': 'PACKAGE'},
          })
        );
        const list = (result.Items || []).map((item) => item.sk as string);
        debug('get packages count=%d', list.length);
        this.logger.trace({count: list.length}, 'aws-s3-storage: [get] found @{count} packages');
        callback(null, list);
      } catch (err) {
        debug('get packages failed: %o', err);
        this.logger.trace({err}, 'aws-s3-storage: [get] query failed');
        callback(err);
      }
    })();
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
          const result = await this.dynamo.send(
            new QueryCommand({
              TableName: this.tableName,
              KeyConditionExpression: 'pk = :pk',
              ExpressionAttributeValues: {':pk': 'PACKAGE'},
            })
          );
          const items = result.Items || [];
          debug('search: found %d packages', items.length);
          for (const item of items) {
            await new Promise<void>((resolve): void => {
              onPackage(
                {
                  name: item.sk as string,
                  path: item.sk as string,
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
      {packageName, bucket: this.config.bucket},
      'aws-s3-storage: [getPackageStorage] creating storage for package=@{packageName} bucket=@{bucket}'
    );
    return new S3PackageManager(this.config, packageName, this.logger, this.s3);
  }

  public async saveToken(token: Token): Promise<void> {
    debug('saveToken user=%o key=%o table=%o', token.user, token.key, this.tableName);
    this.logger.trace(
      {user: token.user, tokenKey: token.key, table: this.tableName},
      'aws-s3-storage: [saveToken] saving token for user=@{user} key=@{tokenKey}'
    );
    await this.dynamo.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `TOKEN#${token.user}`,
          sk: token.key,
          user: token.user,
          key: token.key,
          token: token.token,
          readonly: token.readonly,
          created: token.created,
        },
      })
    );
    debug('saveToken user=%o key=%o stored', token.user, token.key);
    this.logger.trace(
      {user: token.user, tokenKey: token.key},
      'aws-s3-storage: [saveToken] stored user=@{user} key=@{tokenKey}'
    );
  }

  public async deleteToken(user: string, tokenKey: string): Promise<void> {
    debug('deleteToken user=%o key=%o table=%o', user, tokenKey, this.tableName);
    this.logger.trace(
      {user, tokenKey, table: this.tableName},
      'aws-s3-storage: [deleteToken] deleting token user=@{user} key=@{tokenKey}'
    );
    await this.dynamo.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {pk: `TOKEN#${user}`, sk: tokenKey},
      })
    );
    debug('deleteToken user=%o key=%o deleted', user, tokenKey);
    this.logger.trace(
      {user, tokenKey},
      'aws-s3-storage: [deleteToken] deleted user=@{user} key=@{tokenKey}'
    );
  }

  public async readTokens(filter: TokenFilter): Promise<Token[]> {
    debug('readTokens user=%o table=%o', filter.user, this.tableName);
    this.logger.trace(
      {user: filter.user, table: this.tableName},
      'aws-s3-storage: [readTokens] querying tokens for user=@{user}'
    );
    const result = await this.dynamo.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: {':pk': `TOKEN#${filter.user}`},
      })
    );

    const tokens = (result.Items || []).map((item) => ({
      user: item.user as string,
      key: item.sk as string,
      token: item.token as string,
      readonly: item.readonly as boolean,
      created: item.created as string,
    }));
    debug('readTokens user=%o found=%d', filter.user, tokens.length);
    this.logger.trace(
      {user: filter.user, count: tokens.length},
      'aws-s3-storage: [readTokens] found @{count} tokens for user=@{user}'
    );
    return tokens;
  }
}
