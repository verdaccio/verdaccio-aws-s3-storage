import {describe, test, expect} from 'vitest';
import addTrailingSlash from '../src/addTrailingSlash';

describe('addTrailingSlash', () => {
  test('adds trailing slash to path without one', () => {
    expect(addTrailingSlash('some/path')).toBe('some/path/');
  });

  test('does not double-add trailing slash', () => {
    expect(addTrailingSlash('some/path/')).toBe('some/path/');
  });

  test('returns empty string for undefined', () => {
    expect(addTrailingSlash(undefined)).toBe('');
  });

  test('returns empty string for null', () => {
    expect(addTrailingSlash(null as any)).toBe('');
  });

  test('handles single segment path', () => {
    expect(addTrailingSlash('storage')).toBe('storage/');
  });

  test('handles empty string', () => {
    expect(addTrailingSlash('')).toBe('/');
  });

  test('handles root slash', () => {
    expect(addTrailingSlash('/')).toBe('/');
  });
});
