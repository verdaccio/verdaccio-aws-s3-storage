import {createS3Client} from '../src/s3Client';
import type {S3Config} from '../types';

import {S3Client} from '@aws-sdk/client-s3';
import {describe, test, expect} from 'vitest';

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

  test('omits a custom requestHandler when no network options are set', async () => {
    const withDefaults = createS3Client(makeConfig({region: 'us-east-1'}));
    const withOptions = createS3Client(makeConfig({region: 'us-east-1', maxSockets: 3}));

    // Both resolve to NodeHttpHandler; only the opt-in path injects custom timeouts/agents.
    const defaultHandler = (await withDefaults.config.requestHandler) as any;
    const optionHandler = (await withOptions.config.requestHandler) as any;
    const defaultCfg = await defaultHandler.configProvider;
    const optionCfg = await optionHandler.configProvider;

    expect(defaultCfg.connectionTimeout).toBeUndefined();
    expect(defaultCfg.requestTimeout).toBeUndefined();
    expect(defaultCfg.socketTimeout).toBeUndefined();

    expect(optionCfg.connectionTimeout).toBeUndefined();
    expect(optionCfg.requestTimeout).toBeUndefined();
    expect(optionCfg.socketTimeout).toBeUndefined();
    const httpAgent = await optionCfg.httpAgentProvider();
    expect(httpAgent.maxSockets).toBe(3);
  });

  test('honors explicit connectionTimeout, requestTimeout, socketTimeout, maxSockets', async () => {
    const client = createS3Client(
      makeConfig({
        connectionTimeout: 1234,
        requestTimeout: '5678',
        socketTimeout: 9012,
        maxSockets: 3,
      })
    );
    const handler = (await client.config.requestHandler) as any;
    const configs = await handler.configProvider;
    expect(configs.connectionTimeout).toBe(1234);
    expect(configs.requestTimeout).toBe(5678);
    expect(configs.socketTimeout).toBe(9012);
    expect(configs.throwOnRequestTimeout).toBe(true);

    const httpAgent = await configs.httpAgentProvider();
    expect(httpAgent.maxSockets).toBe(3);
    expect(configs.httpsAgent.maxSockets).toBe(3);
  });
});
