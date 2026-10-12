import { describe, expect, it } from 'vitest';
import {
  MAX_DESCRIPTION, parsePublicName, PUBLIC_NAME_RE, publicDescription, toPublicName, ToolIndex,
} from '../../src/mcp/naming.js';

describe('tool naming (GW-07, TC-UNIT-01)', () => {
  it('TC-GW-07-1: same tool name on two upstreams → two distinct public names', () => {
    expect(toPublicName('woo', 'search')).toBe('woo__search');
    expect(toPublicName('github', 'search')).toBe('github__search');
    const idx = new ToolIndex();
    idx.add('u1', 'woo', 'search');
    idx.add('u2', 'github', 'search');
    expect(idx.resolve('woo__search')).toEqual({ upstreamId: 'u1', slug: 'woo', tool: 'search' });
    expect(idx.resolve('github__search')).toEqual({ upstreamId: 'u2', slug: 'github', tool: 'search' });
    expect(idx.conflicts).toEqual([]);
  });

  it('TC-GW-07-2: `__` inside the upstream name → split on the first one', () => {
    expect(toPublicName('everything', 'a__b')).toBe('everything__a__b');
    expect(parsePublicName('everything__a__b')).toEqual({ slug: 'everything', rest: 'a__b' });
    expect(parsePublicName('my-srv__x')).toEqual({ slug: 'my-srv', rest: 'x' });
  });

  it('TC-GW-07-3: parse rejects malformed names', () => {
    for (const bad of ['', 'woo', '__x', 'woo__', 'Woo__x', 'a_b__x', 'toolongslug-abcdefghijk__x', 'woo_x']) {
      expect(parsePublicName(bad), bad).toBeNull();
    }
  });

  it('TC-GW-07-4: names over 64 characters → 55 + _ + 8 hex, deterministic, distinct, resolvable', () => {
    const long1 = `${'x'.repeat(70)}_one`;
    const long2 = `${'x'.repeat(70)}_two`; // same first 55 characters
    const a = toPublicName('github', long1);
    const b = toPublicName('github', long2);
    expect(a).toHaveLength(64);
    expect(a).toMatch(/^github__x{47}_[0-9a-f]{8}$/);
    expect(a).toMatch(PUBLIC_NAME_RE);
    expect(a).not.toBe(b);
    expect(toPublicName('github', long1)).toBe(a);
    const idx = new ToolIndex();
    idx.add('g', 'github', long1);
    idx.add('g', 'github', long2);
    expect(idx.resolve(a)?.tool).toBe(long1);
    expect(idx.resolve(b)?.tool).toBe(long2);
    // exactly 64 characters is kept as is
    const exact = 'y'.repeat(64 - 'woo__'.length);
    expect(toPublicName('woo', exact)).toBe(`woo__${exact}`);
  });

  it('TC-GW-07-5: characters outside [a-zA-Z0-9_-] → sanitized + hash, no collision with the plain name', () => {
    const dotted = toPublicName('srv', 'files.read');
    expect(dotted).toMatch(/^srv__files_read_[0-9a-f]{8}$/);
    expect(dotted).toMatch(PUBLIC_NAME_RE);
    const idx = new ToolIndex();
    idx.add('s', 'srv', 'files.read');
    idx.add('s', 'srv', 'files_read');
    expect(idx.resolve(dotted)?.tool).toBe('files.read');
    expect(idx.resolve('srv__files_read')?.tool).toBe('files_read');
  });

  it('TC-GW-07-6: duplicate public name → first kept, conflict reported, unknown names unresolved', () => {
    const idx = new ToolIndex();
    expect(idx.add('u1', 'woo', 'list')).toBe('woo__list');
    expect(idx.add('u1', 'woo', 'list')).toBeNull();
    expect(idx.conflicts).toEqual([{ upstreamId: 'u1', slug: 'woo', tool: 'list', publicName: 'woo__list', keptTool: 'list' }]);
    expect(idx.size).toBe(1);
    expect(idx.resolve('woo__nope')).toBeUndefined();
    expect(idx.resolve('list')).toBeUndefined();
  });

  it('TC-GW-07-7: invalid slug or empty tool name throws', () => {
    expect(() => toPublicName('Bad_Slug', 'x')).toThrow(/invalid upstream slug/);
    expect(() => toPublicName('woo', '')).toThrow(/empty tool name/);
  });

  it('TC-GW-07-8: descriptions are prefixed with the slug and capped', () => {
    expect(publicDescription('woo', 'List products')).toBe('[woo] List products');
    expect(publicDescription('woo', undefined)).toBe('[woo]');
    const capped = publicDescription('evil', 'A'.repeat(5_000));
    expect(capped).toHaveLength(MAX_DESCRIPTION);
    expect(capped.startsWith('[evil] AAA')).toBe(true);
    expect(capped.endsWith('…')).toBe(true);
  });
});
