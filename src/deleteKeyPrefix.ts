import type {S3Client} from '@aws-sdk/client-s3';
import {ListObjectsV2Command, DeleteObjectsCommand} from '@aws-sdk/client-s3';

import {create404Error} from './s3Errors';

interface DeleteKeyPrefixOptions {
  Bucket: string;
  Prefix: string;
}

export async function deleteKeyPrefix(
  s3: S3Client,
  options: DeleteKeyPrefixOptions
): Promise<void> {
  const listResponse = await s3.send(new ListObjectsV2Command(options));

  if (listResponse.KeyCount) {
    const objectsToDelete = (listResponse.Contents || []).map((obj) => ({Key: obj.Key!}));
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: options.Bucket,
        Delete: {Objects: objectsToDelete},
      })
    );
  } else {
    throw create404Error();
  }
}
