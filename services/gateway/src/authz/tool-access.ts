// BON-01 (REQ-SO-02): per-role tool permissions. Admins may use every tool of every enabled upstream;
// members only what the upstream's `memberAccess` allows: all of it, none of it, or the tools named in
// `memberTools` (upstream tool names). Enforced in /mcp itself — tools/list hides what a caller may not
// use and tools/call refuses it — so API keys, the dashboard chat (internal token) and any UI get the same
// answer. The decision needs only the registry row, never the upstream, so a refusal costs no upstream call.
import type { Role, Upstream } from '../db/schema.js';
import { toPublicName } from '../mcp/naming.js';

export type AccessRow = Pick<Upstream, 'slug' | 'memberAccess' | 'memberTools'>;

/** May `role` see this upstream at all (server list, tools/list)? */
export function canSeeUpstream(role: Role, row: AccessRow): boolean {
  return role === 'admin' || row.memberAccess !== 'none';
}

/** May `role` list and call `tool` (the upstream's own name) of this upstream? */
export function canUseTool(role: Role, row: AccessRow, tool: string): boolean {
  if (role === 'admin' || row.memberAccess === 'all') return true;
  return row.memberAccess === 'selected' && row.memberTools.includes(tool);
}

/**
 * The same decision for a public name a client sent (`<slug>__<tool>`, possibly shortened/hashed by
 * naming.ts). Compared against the public names of the allowed tools, so a guessed or crafted name can
 * only match a tool that is allowed anyway.
 */
export function canCallPublicName(role: Role, row: AccessRow, publicName: string): boolean {
  if (role === 'admin' || row.memberAccess === 'all') return true;
  if (row.memberAccess === 'none') return false;
  return row.memberTools.some((t) => toPublicName(row.slug, t) === publicName);
}
