#!/usr/bin/env node
// TC-P0-04-1: checks that the configured LLM provider returns tool_calls for an MCP-style tool.
// Reads keys from .env; never prints them. Usage: node scripts/llm-smoke.mjs [groq|openrouter]
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const PROVIDERS = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL || 'openai/gpt-oss-120b' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', key: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free' },
};
const name = process.argv[2] || process.env.LLM_PROVIDER || 'groq';
const p = PROVIDERS[name];
if (!p) { console.error(`unknown provider "${name}"`); process.exit(2); }
if (!p.key) { console.error(`FAIL  ${name}: API key not set in .env`); process.exit(1); }

const redact = (s) => String(s).split(p.key).join('***');
const tools = [{
  type: 'function',
  function: {
    name: 'woo__list_orders',
    description: 'List WooCommerce orders',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'processing', 'completed'] },
        after: { type: 'string', description: 'ISO date' },
      },
    },
  },
}];

const started = Date.now();
const res = await fetch(`${p.baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: p.model,
    messages: [{ role: 'user', content: "Show me today's processing orders." }],
    tools,
    tool_choice: 'auto',
    max_tokens: 300,
  }),
  signal: AbortSignal.timeout(30_000),
});
const ms = Date.now() - started;
if (!res.ok) {
  console.error(`FAIL  ${name} ${p.model}: HTTP ${res.status} ${redact((await res.text()).slice(0, 300))}`);
  process.exit(1);
}
const body = await res.json();
const calls = body.choices?.[0]?.message?.tool_calls ?? [];
const limit = res.headers.get('x-ratelimit-remaining-requests');
console.log(`${name} ${p.model}: HTTP ${res.status} in ${ms} ms, finish_reason=${body.choices?.[0]?.finish_reason}` +
  (limit ? `, requests remaining=${limit}` : ''));
for (const c of calls) console.log(`  tool_call ${c.function.name} ${c.function.arguments}`);
if (!calls.some((c) => c.function.name === 'woo__list_orders')) {
  console.error('FAIL  no woo__list_orders tool call returned');
  process.exit(1);
}
console.log('PASS  TC-P0-04-1');
