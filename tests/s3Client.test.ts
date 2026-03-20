import {describe, test, expect} from 'vitest';
import {S3Client} from '@aws-sdk/client-s3';
import {createS3Client} from '../src/s3Client';
import type {S3Config} from '../types';

function makeConfig(overrides: Partial<S3Config> = {}): S3Config {
  return {
    bucket: 'test-bucket',
    keyPrefix: 'prefix/',
    dynamoTableName: 'test-table',
    ...overrides,
  } as S3Config;
}

describe('createS3Client', () => {
  test('returns an S3Client instance', () => {
    const client = createS3Client(makeConfig({region: 'us-east-1'}));
    expect(client).toBeInstanceOf(S3Client);
  });

  test('creates client without credentials when accessKeyId is absent', () => {
    const client = createS3Client(makeConfig({region: 'us-west-2'}));
    expect(client).toBeInstanceOf(S3Client);
  });

  test('creates client with credentials when accessKeyId is provided', () => {
    const client = createS3Client(
      makeConfig({
        region: 'eu-west-1',
        accessKeyId: 'AKID',
        secretAccessKey: 'secret',
        sessionToken: 'token',
      })
    );
    expect(client).toBeInstanceOf(S3Client);
  });

  test('sets forcePathStyle from config', () => {
    const client = createS3Client(makeConfig({s3ForcePathStyle: true}));
    expect(client).toBeInstanceOf(S3Client);
  });
});
