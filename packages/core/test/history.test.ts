import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE, MAX_PAGE, isSessionKey, parsePaging } from '../src/index.js';

describe('history helpers (bridge + relay)', () => {
  it('parsePaging: defaults, clamping, refusals', () => {
    expect(parsePaging(undefined, undefined)).toEqual({ after: 0, limit: DEFAULT_PAGE });
    expect(parsePaging('12', '0')).toEqual({ after: 12, limit: 1 });
    expect(parsePaging('0', '99999')).toEqual({ after: 0, limit: MAX_PAGE });
    for (const [a, l] of [['-1', undefined], ['1.5', undefined], ['', undefined], [undefined, 'x'], [undefined, '123456'], ['1234567890123456', undefined]] as const) {
      expect(parsePaging(a, l)).toBeUndefined();
    }
  });

  it('isSessionKey: source prefix + safe session id', () => {
    expect(isSessionKey('cloud:7c1d0e52-3b8f-4a5e-9d21-0f6b2a9c4e17')).toBe(true);
    expect(isSessionKey('local:abc')).toBe(true);
    for (const k of ['remote:abc', 'cloud:', 'cloud:..', 'cloud:a/b', 'cloud:-x', 'abc', `cloud:${'a'.repeat(201)}`]) expect(isSessionKey(k)).toBe(false);
  });
});
