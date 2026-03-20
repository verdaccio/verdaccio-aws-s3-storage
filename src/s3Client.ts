import {S3Client} from '@aws-sdk/client-s3';

import type {S3Config} from '../types';

export function createS3Client(config: S3Config): S3Client {
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
