import { describe, expect, it } from 'vitest';
import type { Upstream } from '../../src/db/schema.js';
import { aggregateTools } from '../../src/mcp/aggregate.js';

const up = (id: string, slug: string) => ({ id, slug }) as Upstream;

describe('aggregateTools (GW-06)', () => {
  it('TC-GW-06-U7: copies only allowlisted fields, caps title, skips duplicates and unnamed tools', () => {
    const { tools, index } = aggregateTools({
      failed: [],
      upstreams: [{
        upstream: up('u1', 'woo'), fetchedAt: 0, stale: false,
        tools: [
          { name: 'list', title: 'T'.repeat(500), description: 'd', inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true }, _meta: { secret: 'x' }, icons: [{ src: 'http://evil' }] },
          { name: 'list', inputSchema: { type: 'object' } },
          { name: '', inputSchema: { type: 'object' } },
        ],
      }],
    } as never);
    expect(tools).toEqual([{
      name: 'woo__list', title: 'T'.repeat(128), description: '[woo] d',
      inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
    }]);
    expect(index.resolve('woo__list')).toEqual({ upstreamId: 'u1', slug: 'woo', tool: 'list' });
    expect(index.conflicts).toHaveLength(1);
  });
});
