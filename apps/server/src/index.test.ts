import { describe, expect, it } from 'vitest';
import { healthz } from './index.js';

describe('server skeleton', () => {
  it('reports healthy with phase marker', () => {
    expect(healthz()).toEqual({ ok: true, version: '0.9.0-beta', phase: 'P2-beta' });
  });
});
