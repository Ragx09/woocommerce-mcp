#!/usr/bin/env node
// SEC-06: summary of a kubescape JSON report (stdout of `kubescape scan … --format json`). Prints the
// compliance score and one line per failed control and resource: TRIAGED (reason below) or FAIL.
import { readFileSync } from 'node:fs';

// Reviewed failures: control → { resource kind/name → reason }. Anything else that fails is a FAIL.
const TRIAGE = {
  'C-0012': {
    'Deployment/gateway': 'false positive: env MCP_RATE_LIMIT_PER_APIKEY=120 is a rate limit (the name contains "APIKEY"); every credential comes from a secretKeyRef',
  },
};

const text = readFileSync(process.argv[2], 'utf8');
const report = JSON.parse(text.slice(text.indexOf('{"generationTime')));
console.log(`compliance score ${report.summaryDetails.complianceScore.toFixed(2)} (frameworks: ${report.summaryDetails.frameworks.map((f) => `${f.name} ${f.complianceScore.toFixed(1)}`).join(', ')})`);
let failed = 0;
for (const res of report.results) {
  const [, , , kind, name] = res.resourceID.split('/').slice(-5);
  for (const c of res.controls.filter((x) => x.status.status === 'failed')) {
    failed++;
    const reason = TRIAGE[c.controlID]?.[`${kind}/${name}`];
    const paths = [...new Set(c.rules.flatMap((r) => (r.paths ?? []).map((p) => p.failedPath ?? p.deletePath).filter(Boolean)))];
    console.log(`${reason ? 'TRIAGED' : 'FAIL   '} ${c.controlID} ${c.name} — ${kind}/${name} ${paths.slice(0, 3).join(', ')}${reason ? `\n        ${reason}` : ''}`);
  }
}
if (!failed) console.log('no failed controls');
