import type {S3Client} from '@aws-sdk/client-s3';
import {ListObjectsV2Command, DeleteObjectsCommand} from '@aws-sdk/client-s3';
import debugCore from 'debug';

import {create404Error} from './s3Errors';

const debug = debugCore('verdaccio:plugin:aws-s3-storage:delete-prefix');

interface DeleteKeyPrefixOptions {
  Bucket: string;
  Prefix: string;
}

export async function deleteKeyPrefix(s3: S3Client, options: DeleteKeyPrefixOptions): Promise<void> {
  debug('listing objects bucket=%o prefix=%o', options.Bucket, options.Prefix);
  const listResponse = await s3.send(new ListObjectsV2Command(options));

  if (listResponse.KeyCount) {
    const objectsToDelete = (listResponse.Contents || []).map((obj) => ({Key: obj.Key!}));
    debug('deleting %d objects from bucket=%o', objectsToDelete.length, options.Bucket);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: options.Bucket,
        Delete: {Objects: objectsToDelete},
      })
    );
    debug('successfully deleted %d objects', objectsToDelete.length);
  } else {
    debug('no objects found under prefix=%o, throwing 404', options.Prefix);
    throw create404Error();
  }
}
