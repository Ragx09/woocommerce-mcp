#!/usr/bin/env node
// TC-SEC-01-1: docs/SECURITY_FINDINGS.md parses — one row per finding, all columns filled, known
// status, unique IDs. Fixed needs a fix commit and a regression test; Accepted needs a reason.
// `--signoff` (SEC-09) additionally fails while any finding is still Open.
import { readFileSync } from 'node:fs';

const file = process.env.FINDINGS_FILE ?? new URL('../../docs/SECURITY_FINDINGS.md', import.meta.url);
const cols = ['ID', 'Found by', 'Severity', 'Component', 'Description', 'Fix commit', 'Regression test', 'Status'];
const severities = new Set(['Critical', 'High', 'Medium', 'Low', 'Info']);
const statuses = new Set(['Open', 'Fixed', 'Accepted', 'False positive']);
const signoff = process.argv.includes('--signoff');

const lines = readFileSync(file, 'utf8').split('\n');
const start = lines.findIndex((l) => l.startsWith('| ID |'));
if (start < 0) { console.log('FAIL  findings table header not found'); process.exit(1); }
const header = lines[start].split('|').slice(1, -1).map((c) => c.trim());
const errors = [];
if (header.join() !== cols.join()) errors.push(`header is "${header.join(' | ')}"`);

const ids = new Set();
const count = { total: 0 };
for (const line of lines.slice(start + 2)) {
  if (!line.startsWith('|')) break;
  // Cells may contain escaped pipes (\|) inside code; split on unescaped ones only.
  const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
  const row = Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  const id = row.ID || `(row ${count.total + 1})`;
  count.total++;
  count[row.Status] = (count[row.Status] ?? 0) + 1;
  if (cells.length !== cols.length) errors.push(`${id}: ${cells.length} columns, want ${cols.length}`);
  if (!/^F-[A-Z]+-\d+$/.test(row.ID)) errors.push(`${id}: ID must look like F-AREA-n`);
  if (ids.has(row.ID)) errors.push(`${id}: duplicate ID`);
  ids.add(row.ID);
  for (const c of ['Found by', 'Component', 'Description']) if (!row[c] || row[c] === '—') errors.push(`${id}: empty ${c}`);
  if (!severities.has(row.Severity)) errors.push(`${id}: severity "${row.Severity}"`);
  if (!statuses.has(row.Status)) errors.push(`${id}: status "${row.Status}"`);
  if (row.Status === 'Fixed') {
    if (!row['Fix commit'] || row['Fix commit'] === '—') errors.push(`${id}: Fixed without a fix commit`);
    if (!row['Regression test'] || row['Regression test'] === '—') errors.push(`${id}: Fixed without a regression test`);
  }
  if ((row.Status === 'Accepted' || row.Status === 'False positive') && !/\*\*Fix\/decision:\*\*\s*\S/.test(row.Description))
    errors.push(`${id}: ${row.Status} without a reason (**Fix/decision:**)`);
  if (signoff && row.Status === 'Open') errors.push(`${id}: still Open (${row.Severity})`);
}
if (count.total === 0) errors.push('no findings rows');
// A blank line inside the table used to hide every row below it from this check (11 rows, found in SEC-09): any finding row after the table ends is an error.
const tableEnd = start + 2 + count.total;
for (const [i, line] of lines.slice(tableEnd).entries()) if (/^\|\s*F-[A-Z]+-\d+\s*\|/.test(line)) errors.push(`row "${line.slice(0, 40).trim()}…" (line ${tableEnd + i + 1}) is outside the findings table: remove the blank line above it`);

const summary = Object.entries(count).map(([k, v]) => `${k} ${v}`).join(', ');
for (const e of errors) console.log(`FAIL  ${e}`);
console.log(errors.length ? `FAIL  findings table (${summary})` : `PASS  findings table${signoff ? ' sign-off' : ''} (${summary})`);
process.exit(errors.length ? 1 : 0);
