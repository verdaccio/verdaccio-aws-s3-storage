import {describe, test, expect} from 'vitest';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createDynamoClient} from '../src/dynamoClient';
import type {S3Config} from '../types';

function makeConfig(overrides: Partial<S3Config> = {}): S3Config {
  return {
    bucket: 'test-bucket',
    keyPrefix: 'prefix/',
    dynamoTableName: 'test-table',
    ...overrides,
  } as S3Config;
}

describe('createDynamoClient', () => {
  test('returns a DynamoDBDocumentClient instance', () => {
    const client = createDynamoClient(makeConfig({region: 'us-east-1'}));
    expect(client).toBeInstanceOf(DynamoDBDocumentClient);
  });

  test('uses dynamoRegion when provided', () => {
    const client = createDynamoClient(makeConfig({region: 'us-east-1', dynamoRegion: 'eu-west-1'}));
    expect(client).toBeInstanceOf(DynamoDBDocumentClient);
  });

  test('falls back to region when dynamoRegion is not set', () => {
    const client = createDynamoClient(makeConfig({region: 'ap-southeast-1'}));
    expect(client).toBeInstanceOf(DynamoDBDocumentClient);
  });

  test('creates client with credentials when provided', () => {
    const client = createDynamoClient(
      makeConfig({
        accessKeyId: 'AKID',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      })
    );
    expect(client).toBeInstanceOf(DynamoDBDocumentClient);
  });
});
