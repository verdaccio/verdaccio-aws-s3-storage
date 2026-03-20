import {GetCommand, PutCommand, DeleteCommand, QueryCommand} from '@aws-sdk/lib-dynamodb';
import type {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import type {S3Client} from '@aws-sdk/client-s3';
import debugCore from 'debug';

import type {searchUtils} from '@verdaccio/core';
import {errorUtils} from '@verdaccio/core';
import type {Callback, Config, Logger, Token, TokenFilter} from '@verdaccio/types';

import type {S3Config} from '../types';
import addTrailingSlash from './addTrailingSlash';
import {createDynamoClient} from './dynamoClient';
import {createS3Client} from './s3Client';
import S3PackageManager from './s3PackageManager';
import setConfigValue from './setConfigValue';

const debug = debugCore('verdaccio:plugin:aws-s3-storage');

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
    this.config = Object.assign(config, config.store['aws-s3-storage']) as S3Config;

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

    const configKeyPrefix = this.config.keyPrefix;
    this.config.keyPrefix = addTrailingSlash(configKeyPrefix);
    this.tableName = this.config.dynamoTableName;

    debug('configuration: %o', this.config);

    this.s3 = createS3Client(this.config);
    this.dynamo = createDynamoClient(this.config);
  }

  public async getSecret(): Promise<string> {
    debug('getSecret');
    try {
      const result = await this.dynamo.send(
        new GetCommand({
          TableName: this.tableName,
          Key: {pk: 'CONFIG', sk: 'SECRET'},
        })
      );
      return result.Item?.secret ?? '';
    } catch (err) {
      debug('getSecret error: %o', err);
      return '';
    }
  }

  public async setSecret(secret: string): Promise<void> {
    debug('setSecret');
    await this.dynamo.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {pk: 'CONFIG', sk: 'SECRET', secret},
      })
    );
  }

  public add(name: string, callback: Callback): void {
    debug('add package: %o', name);
    void (async (): Promise<void> => {
      try {
        await this.dynamo.send(
          new PutCommand({
            TableName: this.tableName,
            Item: {pk: 'PACKAGE', sk: name, name},
          })
        );
        callback(null);
      } catch (err) {
        debug('add error: %o', err);
        callback(err);
      }
    })();
  }

  public remove(name: string, callback: Callback): void {
    debug('remove package: %o', name);
    void (async (): Promise<void> => {
      try {
        await this.dynamo.send(
          new DeleteCommand({
            TableName: this.tableName,
            Key: {pk: 'PACKAGE', sk: name},
          })
        );
        callback(null);
      } catch (err) {
        debug('remove error: %o', err);
        callback(err);
      }
    })();
  }

  public get(callback: Callback): void {
    debug('get all packages');
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
        callback(null, list);
      } catch (err) {
        debug('get error: %o', err);
        callback(err);
      }
    })();
  }

  public async search(_query: searchUtils.SearchQuery): Promise<searchUtils.SearchItem[]> {
    debug('search');
    throw errorUtils.getServiceUnavailable();
  }

  public async filterByQuery(
    _results: searchUtils.SearchItemPkg[],
    _query: searchUtils.SearchQuery
  ): Promise<searchUtils.SearchItemPkg[]> {
    throw errorUtils.getServiceUnavailable();
  }

  public async getScore(_pkg: searchUtils.SearchItemPkg): Promise<searchUtils.Score> {
    throw errorUtils.getServiceUnavailable();
  }

  public getPackageStorage(packageName: string): S3PackageManager {
    debug('getPackageStorage: %o', packageName);
    return new S3PackageManager(this.config, packageName, this.logger, this.s3);
  }

  public async saveToken(token: Token): Promise<void> {
    debug('saveToken for user: %o', token.user);
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
  }

  public async deleteToken(user: string, tokenKey: string): Promise<void> {
    debug('deleteToken for user: %o key: %o', user, tokenKey);
    await this.dynamo.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {pk: `TOKEN#${user}`, sk: tokenKey},
      })
    );
  }

  public async readTokens(filter: TokenFilter): Promise<Token[]> {
    debug('readTokens for user: %o', filter.user);
    const result = await this.dynamo.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: {':pk': `TOKEN#${filter.user}`},
      })
    );

    return (result.Items || []).map((item) => ({
      user: item.user as string,
      key: item.sk as string,
      token: item.token as string,
      readonly: item.readonly as boolean,
      created: item.created as string,
    }));
  }
}
