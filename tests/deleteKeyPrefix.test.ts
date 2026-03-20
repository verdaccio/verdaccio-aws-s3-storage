import {describe, test, expect, vi} from 'vitest';
import {DeleteObjectsCommand} from '@aws-sdk/client-s3';
import {deleteKeyPrefix} from '../src/deleteKeyPrefix';

function createFakeS3Client(responses: Record<string, any>) {
  return {
    send: vi.fn(async (command: any) => {
      const name = command.constructor.name;
      if (responses[name] instanceof Error) {
        throw responses[name];
      }
      return responses[name] ?? {};
    }),
  } as any;
}

describe('deleteKeyPrefix', () => {
  test('deletes objects when keys exist', async () => {
    const s3 = createFakeS3Client({
      ListObjectsV2Command: {
        KeyCount: 2,
        Contents: [{Key: 'prefix/a'}, {Key: 'prefix/b'}],
      },
      DeleteObjectsCommand: {},
    });

    await deleteKeyPrefix(s3, {Bucket: 'test-bucket', Prefix: 'prefix/'});

    expect(s3.send).toHaveBeenCalledTimes(2);
    const deleteCall = s3.send.mock.calls[1][0];
    expect(deleteCall).toBeInstanceOf(DeleteObjectsCommand);
    expect(deleteCall.input.Delete.Objects).toEqual([{Key: 'prefix/a'}, {Key: 'prefix/b'}]);
  });

  test('throws 404 when no keys found', async () => {
    const s3 = createFakeS3Client({
      ListObjectsV2Command: {KeyCount: 0, Contents: []},
    });

    await expect(
      deleteKeyPrefix(s3, {Bucket: 'test-bucket', Prefix: 'prefix/'})
    ).rejects.toMatchObject({code: 404});
  });

  test('propagates S3 list errors', async () => {
    const s3 = createFakeS3Client({
      ListObjectsV2Command: new Error('access denied'),
    });

    await expect(deleteKeyPrefix(s3, {Bucket: 'test-bucket', Prefix: 'prefix/'})).rejects.toThrow(
      'access denied'
    );
  });
});
