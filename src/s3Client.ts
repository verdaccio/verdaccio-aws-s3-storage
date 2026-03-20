import {S3Client} from '@aws-sdk/client-s3';
import debugCore from 'debug';

import type {S3Config} from '../types';

const debug = debugCore('verdaccio:plugin:aws-s3-storage:s3-client');

export function createS3Client(config: S3Config): S3Client {
  debug(
    'creating S3Client endpoint=%o region=%o forcePathStyle=%o credentials=%o',
    config.endpoint,
    config.region,
    config.s3ForcePathStyle,
    config.accessKeyId ? 'explicit' : 'default-chain'
  );

  return new S3Client({
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
  });
}
