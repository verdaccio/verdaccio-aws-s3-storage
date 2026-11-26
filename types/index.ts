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
  dynamoTableName: string;
  /** S3-only mode: write the database with If-Match and retry on 412. */
  conditionalWrites?: boolean;
  dynamoEndpoint?: string;
  dynamoRegion?: string;
}
