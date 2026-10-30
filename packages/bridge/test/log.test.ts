import { describe, expect, it } from 'vitest';
import { consoleLogger } from '../src/log.js';

describe('consoleLogger', () => {
  it('writes one line per event: kind, 8-char id prefix, status; anything odd in them is neutralised', () => {
    const lines: string[] = [];
    const log = consoleLogger((l) => lines.push(l));
    log.event('tool.start', 'a'.repeat(64), '204');
    log.event('evil\nkind\u001b[31m', 'id\nwith newline', 'dup licate');
    log.info('listening');
    log.warn('careful');
    expect(lines[0]).toBe('event tool.start aaaaaaaa 204');
    expect(lines).toHaveLength(4);
    for (const l of lines) for (const bad of ['\n', '\r', '\u001b']) expect(l.includes(bad)).toBe(false);
    expect(lines[1]).toMatch(/^event evil\?kind\?\?31m id\?with\? dup\?licate$/);
    expect(lines.slice(2)).toEqual(['info listening', 'warn careful']);
  });
});
