import {errorUtils} from '@verdaccio/core';
import type {VerdaccioError} from '@verdaccio/core';

export function is404Error(err: VerdaccioError): boolean {
  return err.code === 404;
}

export function create404Error(): VerdaccioError {
  return errorUtils.getNotFound('no such package available');
}

export function is409Error(err: VerdaccioError): boolean {
  return err.code === 409;
}

export function create409Error(): VerdaccioError {
  return errorUtils.getConflict('file already exists');
}

export function is503Error(err: VerdaccioError): boolean {
  return err.code === 503;
}

export function create503Error(): VerdaccioError {
  return errorUtils.getCode(503, 'resource temporarily unavailable');
}

export function convertS3Error(err: any): VerdaccioError {
  const errorName = err.name || err.code || '';
  switch (errorName) {
    case 'NoSuchKey':
    case 'NotFound':
    case '404':
      return errorUtils.getNotFound();
    case 'StreamContentLengthMismatch':
      return errorUtils.getInternalError('content length mismatch');
    case 'RequestAbortedError':
      return errorUtils.getInternalError('request aborted');
    default:
      return errorUtils.getCode(
        err.$metadata?.httpStatusCode || err.statusCode || 500,
        err.message
      );
  }
}
