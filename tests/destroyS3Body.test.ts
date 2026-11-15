import {destroyS3Body} from '../src/destroyS3Body';

import {PassThrough} from 'stream';
import {describe, test, expect, vi} from 'vitest';

describe('destroyS3Body', () => {
  test('destroys a readable body that is still open', () => {
    const body = new PassThrough();
    const destroy = vi.spyOn(body, 'destroy');
    destroyS3Body(body);
    expect(destroy).toHaveBeenCalledOnce();
  });

  test('is a no-op for nullish or non-stream values', () => {
    expect(() => destroyS3Body(undefined)).not.toThrow();
    expect(() => destroyS3Body(null)).not.toThrow();
    expect(() => destroyS3Body('x')).not.toThrow();
  });

  test('skips bodies that were already destroyed', () => {
    const body = new PassThrough();
    body.destroy();
    const destroy = vi.spyOn(body, 'destroy');
    destroyS3Body(body);
    expect(destroy).not.toHaveBeenCalled();
  });
});
