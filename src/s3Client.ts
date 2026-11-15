import type {S3Config} from '../types';

import {S3Client} from '@aws-sdk/client-s3';
import type {S3ClientConfig} from '@aws-sdk/client-s3';
import debugCore from 'debug';
import {Agent as HttpAgent} from 'node:http';
import {Agent as HttpsAgent} from 'node:https';

const debug = debugCore('verdaccio:plugin:aws-s3-storage:s3-client');

function resolveOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function createS3Client(config: S3Config): S3Client {
  const connectionTimeout = resolveOptionalNumber(config.connectionTimeout);
  const requestTimeout = resolveOptionalNumber(config.requestTimeout);
  const socketTimeout = resolveOptionalNumber(config.socketTimeout);
  const maxSockets = resolveOptionalNumber(config.maxSockets);
  const useCustomHandler =
    connectionTimeout !== undefined ||
    requestTimeout !== undefined ||
    socketTimeout !== undefined ||
    maxSockets !== undefined;

  debug(
    'creating S3Client endpoint=%o region=%o forcePathStyle=%o credentials=%o customHandler=%o connectionTimeout=%o requestTimeout=%o socketTimeout=%o maxSockets=%o',
    config.endpoint,
    config.region,
    config.s3ForcePathStyle,
    config.accessKeyId ? 'explicit' : 'default-chain',
    useCustomHandler,
    connectionTimeout,
    requestTimeout,
    socketTimeout,
    maxSockets
  );

  const clientConfig: S3ClientConfig = {
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.s3ForcePathStyle,
    credentials: config.accessKeyId
      ? {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey!,
          sessionToken: config.sessionToken,
        }
      : undefined,
  };

  // Network options are opt-in. With none set, omit requestHandler so the AWS SDK
  // keeps its built-in NodeHttpHandler defaults (no finite timeouts, maxSockets=50).
  if (useCustomHandler) {
    clientConfig.requestHandler = {
      ...(connectionTimeout !== undefined ? {connectionTimeout} : {}),
      ...(requestTimeout !== undefined
        ? {requestTimeout, throwOnRequestTimeout: requestTimeout > 0}
        : {}),
      ...(socketTimeout !== undefined ? {socketTimeout} : {}),
      // Eager Agent instances only when maxSockets is configured. Passing plain
      // agent option objects makes NodeHttpHandler lazy-create the HTTP agent
      // inside handle(); concurrent first requests can race and each get a
      // separate Agent, so maxSockets would not be shared across the pool.
      ...(maxSockets !== undefined
        ? {
            httpAgent: new HttpAgent({maxSockets, keepAlive: true}),
            httpsAgent: new HttpsAgent({maxSockets, keepAlive: true}),
          }
        : {}),
    };
  }

  return new S3Client(clientConfig);
}
