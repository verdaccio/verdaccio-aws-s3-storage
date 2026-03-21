import {join} from 'node:path';

import {describe, expect, test} from 'vitest';

import {verifyPlugin} from '@verdaccio/plugin-verifier';

describe('Plugin loading verification', () => {
  test('should be loadable by verdaccio as a storage plugin', async () => {
    const result = await verifyPlugin({
      pluginPath: 'aws-s3-storage',
      category: 'storage',
      pluginsFolder: join(import.meta.dirname, '..', '..'),
      pluginConfig: {
        bucket: 'test-bucket',
        keyPrefix: 'test/',
        region: 'us-east-1',
        dynamoTableName: 'test-table',
      },
    });

    expect(result.success).toBe(true);
    expect(result.pluginsLoaded).toBe(1);
  });
});
