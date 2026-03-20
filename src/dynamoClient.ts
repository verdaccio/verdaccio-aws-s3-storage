import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';

import type {S3Config} from '../types';

export function createDynamoClient(config: S3Config): DynamoDBDocumentClient {
  const client = new DynamoDBClient({
    endpoint: config.dynamoEndpoint,
    region: config.dynamoRegion || config.region,
    credentials: config.accessKeyId
      ? {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey!,
          sessionToken: config.sessionToken,
        }
      : undefined,
  });

  return DynamoDBDocumentClient.from(client);
}
