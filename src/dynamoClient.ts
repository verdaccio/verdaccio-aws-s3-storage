import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import debugCore from 'debug';

import type {S3Config} from '../types';

const debug = debugCore('verdaccio:plugin:aws-s3-storage:dynamo-client');

export function createDynamoClient(config: S3Config): DynamoDBDocumentClient {
  const region = config.dynamoRegion || config.region;
  debug(
    'creating DynamoDBClient endpoint=%o region=%o credentials=%o',
    config.dynamoEndpoint,
    region,
    config.accessKeyId ? 'explicit' : 'default-chain'
  );

  const client = new DynamoDBClient({
    endpoint: config.dynamoEndpoint,
    region,
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
