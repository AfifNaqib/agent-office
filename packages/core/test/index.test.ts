import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE } from '../src/index.js';

describe('core package', () => {
  it('exposes its entry point', () => {
    expect(CORE_PACKAGE).toBe('@agent-office/core');
  });
});
