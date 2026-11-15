import type {Config} from '@verdaccio/types';

export interface S3Config extends Config {
  bucket: string;
  keyPrefix: string;
  endpoint?: string;
  region?: string;
  s3ForcePathStyle?: boolean;
  tarballACL?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  proxy?: string;
  /**
   * Optional. Max time in ms to establish a TCP connection to S3/MinIO.
   * When unset (with the other network options), the AWS SDK defaults apply.
   */
  connectionTimeout?: number | string;
  /**
   * Optional. Max time in ms for the full HTTP request+response.
   * When > 0 the client throws on timeout (`throwOnRequestTimeout`).
   * When unset (with the other network options), the AWS SDK defaults apply.
   */
  requestTimeout?: number | string;
  /**
   * Optional. Max idle time in ms for a socket before it is closed.
   * When unset (with the other network options), the AWS SDK defaults apply.
   */
  socketTimeout?: number | string;
  /**
   * Optional. Max concurrent sockets per host in the keep-alive pool.
   * When unset (with the other network options), the AWS SDK default (50) applies.
   */
  maxSockets?: number | string;
  dynamoTableName: string;
  dynamoEndpoint?: string;
  dynamoRegion?: string;
}
