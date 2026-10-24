// GW-06: discovered upstream tools → one public tool list (docs/MCP_DESIGN.md §3–4).
// Only an allowlist of tool fields is copied: upstream extras (_meta, icons, …) are not forwarded.
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DiscoveryResult } from '../upstreams/discovery.js';
import { publicDescription, ToolIndex } from './naming.js';

const MAX_TITLE = 128;

export interface Aggregate {
  tools: Tool[];
  index: ToolIndex;
}

/**
 * `allow` (BON-01) drops tools the caller may not use before names are assigned; it is given the
 * upstream id and the upstream's own tool name.
 */
export function aggregateTools(result: DiscoveryResult, allow?: (upstreamId: string, tool: string) => boolean): Aggregate {
  const index = new ToolIndex();
  const tools: Tool[] = [];
  for (const { upstream, tools: upstreamTools } of result.upstreams) {
    for (const t of upstreamTools) {
      if (!t.name) continue; // malformed upstream entry
      if (allow && !allow(upstream.id, t.name)) continue;
      const name = index.add(upstream.id, upstream.slug, t.name);
      if (!name) continue; // duplicate public name: reported in index.conflicts
      const tool: Tool = { name, description: publicDescription(upstream.slug, t.description), inputSchema: t.inputSchema };
      if (t.title) tool.title = t.title.slice(0, MAX_TITLE);
      if (t.outputSchema) tool.outputSchema = t.outputSchema;
      if (t.annotations) tool.annotations = t.annotations;
      tools.push(tool);
    }
  }
  return { tools, index };
}
