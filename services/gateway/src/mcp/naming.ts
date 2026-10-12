// GW-07: public tool names (D-005, docs/MCP_DESIGN.md §3).
// - Every tool is exposed as `<slug>__<tool>`: collision-free across upstreams by construction.
// - Public names must satisfy the Claude/OpenAI rule ^[a-zA-Z0-9_-]{1,64}$. A name that is too long
//   or contains other characters (MCP allows e.g. `.`) becomes: sanitized name cut to 55 characters
//   + `_` + the first 8 hex characters of sha1(`<slug>__<tool>`). Deterministic across replicas.
// - Such a name cannot be parsed back, so routing resolves public names through a ToolIndex built
//   from the discovered tool list, never by string splitting alone.
// - Descriptions get a `[slug] ` prefix (the model/user sees where a tool comes from) and are capped
//   (an upstream must not flood the model's context, T-07).
import { createHash } from 'node:crypto';

export const SLUG_RE = /^[a-z0-9-]{1,20}$/;
export const PUBLIC_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const SEPARATOR = '__';
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;
const HASH_LEN = 8;
const HEAD_LEN = MAX_NAME - HASH_LEN - 1; // 55

export function toPublicName(slug: string, tool: string): string {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid upstream slug: ${JSON.stringify(slug)}`);
  if (!tool) throw new Error('empty tool name');
  const full = `${slug}${SEPARATOR}${tool}`;
  if (PUBLIC_NAME_RE.test(full)) return full;
  const hash = createHash('sha1').update(full).digest('hex').slice(0, HASH_LEN);
  return `${full.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, HEAD_LEN)}_${hash}`;
}

/**
 * Splits on the first `__` (slugs cannot contain `_`, so upstream names containing `__` survive).
 * Returns null for anything that is not `<valid slug>__<non-empty rest>`. `rest` equals the upstream
 * tool name only for unshortened names; use ToolIndex to resolve.
 */
export function parsePublicName(name: string): { slug: string; rest: string } | null {
  const i = name.indexOf(SEPARATOR);
  if (i <= 0) return null;
  const slug = name.slice(0, i);
  const rest = name.slice(i + SEPARATOR.length);
  return SLUG_RE.test(slug) && rest ? { slug, rest } : null;
}

export function publicDescription(slug: string, description: string | undefined): string {
  const text = `[${slug}] ${(description ?? '').trim()}`.trimEnd();
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
}

export interface ToolRef {
  upstreamId: string;
  slug: string;
  /** The tool's name as the upstream knows it. */
  tool: string;
}

export interface IndexConflict extends ToolRef {
  publicName: string;
  /** The tool that already owns this public name. */
  keptTool: string;
}

/**
 * Public name → upstream tool, built from discovered lists. A duplicate public name (an upstream
 * listing the same tool twice, or a hash-suffix clash) keeps the first and reports the rest, so a
 * public name always routes to exactly one tool.
 */
export class ToolIndex {
  private readonly map = new Map<string, ToolRef>();
  readonly conflicts: IndexConflict[] = [];

  add(upstreamId: string, slug: string, tool: string): string | null {
    const publicName = toPublicName(slug, tool);
    const existing = this.map.get(publicName);
    if (existing) {
      this.conflicts.push({ upstreamId, slug, tool, publicName, keptTool: existing.tool });
      return null;
    }
    this.map.set(publicName, { upstreamId, slug, tool });
    return publicName;
  }

  resolve(publicName: string): ToolRef | undefined {
    return this.map.get(publicName);
  }

  get size(): number {
    return this.map.size;
  }
}
