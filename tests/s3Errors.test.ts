import {describe, test, expect} from 'vitest';
import {
  is404Error,
  create404Error,
  is409Error,
  create409Error,
  is503Error,
  create503Error,
  convertS3Error,
} from '../src/s3Errors';

describe('s3Errors', () => {
  describe('create and check errors', () => {
    test('create404Error returns a 404 VerdaccioError', () => {
      const err = create404Error();
      expect(err.code).toBe(404);
      expect(err.message).toContain('no such package');
    });

    test('is404Error identifies 404 errors', () => {
      expect(is404Error(create404Error())).toBe(true);
      expect(is404Error(create409Error())).toBe(false);
    });

    test('create409Error returns a 409 VerdaccioError', () => {
      const err = create409Error();
      expect(err.code).toBe(409);
      expect(err.message).toContain('file already exists');
    });

    test('is409Error identifies 409 errors', () => {
      expect(is409Error(create409Error())).toBe(true);
      expect(is409Error(create404Error())).toBe(false);
    });

    test('create503Error returns a 503 VerdaccioError', () => {
      const err = create503Error();
      expect(err.code).toBe(503);
      expect(err.message).toContain('resource temporarily unavailable');
    });

    test('is503Error identifies 503 errors', () => {
      expect(is503Error(create503Error())).toBe(true);
      expect(is503Error(create404Error())).toBe(false);
    });
  });

  describe('convertS3Error', () => {
    test('converts NoSuchKey to 404', () => {
      const err = convertS3Error({name: 'NoSuchKey', message: 'not found'});
      expect(is404Error(err)).toBe(true);
    });

    test('converts NotFound to 404', () => {
      const err = convertS3Error({name: 'NotFound', message: 'not found'});
      expect(is404Error(err)).toBe(true);
    });

    test('converts error code "404" string to 404', () => {
      const err = convertS3Error({code: '404', message: 'missing'});
      expect(is404Error(err)).toBe(true);
    });

    test('converts StreamContentLengthMismatch to 500', () => {
      const err = convertS3Error({name: 'StreamContentLengthMismatch', message: 'mismatch'});
      expect(err.code).toBe(500);
      expect(err.message).toContain('content length mismatch');
    });

    test('converts RequestAbortedError to 500', () => {
      const err = convertS3Error({name: 'RequestAbortedError', message: 'aborted'});
      expect(err.code).toBe(500);
      expect(err.message).toContain('request aborted');
    });

    test('uses $metadata.httpStatusCode for unknown errors', () => {
      const err = convertS3Error({
        name: 'SomeOtherError',
        message: 'something broke',
        $metadata: {httpStatusCode: 403},
      });
      expect(err.code).toBe(403);
      expect(err.message).toBe('something broke');
    });

    test('falls back to 500 when no status code available', () => {
      const err = convertS3Error({name: 'Unknown', message: 'unknown error'});
      expect(err.code).toBe(500);
    });
  });
});
