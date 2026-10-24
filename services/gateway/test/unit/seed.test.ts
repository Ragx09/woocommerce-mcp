import { describe, expect, it } from 'vitest';
import { loadSeeds } from '../../src/upstreams/seed.js';

const WOO = { SEED_WOO_URL: 'http://woo-mcp.store.svc.cluster.local/mcp', SEED_WOO_TOKEN: 'woo-secret' };

describe('loadSeeds (GW-03/13/14)', () => {
  it('TC-GW-13-U1: chart env → woo, everything (no auth), github (PAT as bearer), in that order', () => {
    const plan = loadSeeds({ ...WOO,
      SEED_EVERYTHING_URL: 'http://everything-mcp.platform.svc.cluster.local/mcp',
      SEED_GITHUB_URL: 'https://api.githubcopilot.com/mcp/', SEED_GITHUB_TOKEN: ' github_pat_x ' });
    expect(plan.skipped).toEqual([]);
    expect(plan.seeds.map((s) => [s.slug, s.authType])).toEqual([['woo', 'bearer'], ['everything', 'none'], ['github', 'bearer']]);
    expect(plan.seeds[1]).toMatchObject({ name: 'Everything (reference)', url: 'http://everything-mcp.platform.svc.cluster.local/mcp' });
    expect(plan.seeds[1]!.credential).toBeUndefined();
    expect(plan.seeds[2]).toMatchObject({ name: 'GitHub', credential: 'github_pat_x' });
  });

  it('TC-GW-14-U1: github turned on without a PAT → skipped with a reason that holds no secret; the rest still seeded', () => {
    const plan = loadSeeds({ ...WOO, SEED_GITHUB_URL: 'https://api.githubcopilot.com/mcp/', SEED_GITHUB_TOKEN: '  ' });
    expect(plan.seeds.map((s) => s.slug)).toEqual(['woo']);
    expect(plan.skipped).toEqual([{ slug: 'github', reason: expect.stringContaining('SEED_GITHUB_TOKEN is empty') }]);
    expect(JSON.stringify(plan.skipped)).not.toContain('woo-secret');
  });

  it('nothing configured → nothing seeded; woo URL without token is a startup error', () => {
    expect(loadSeeds({})).toEqual({ seeds: [], skipped: [] });
    expect(() => loadSeeds({ SEED_WOO_URL: WOO.SEED_WOO_URL })).toThrow('SEED_WOO_TOKEN is required');
  });

  it('TC-BON-01-U4 / F-MCP-2: member tool lists from the chart (woo read-only, everything without get-env); empty → no rule', () => {
    const plan = loadSeeds({ ...WOO, SEED_WOO_MEMBER_TOOLS: 'list_products, list_orders,get_order',
      SEED_EVERYTHING_URL: 'http://everything-mcp.platform.svc.cluster.local/mcp', SEED_EVERYTHING_MEMBER_TOOLS: 'echo,get-sum' });
    expect(plan.seeds.map((s) => [s.slug, s.memberTools])).toEqual([['woo', ['list_products', 'list_orders', 'get_order']], ['everything', ['echo', 'get-sum']]]);
    expect(loadSeeds({ ...WOO, SEED_WOO_MEMBER_TOOLS: ' , ' }).seeds[0]!.memberTools).toBeUndefined();
  });
});
