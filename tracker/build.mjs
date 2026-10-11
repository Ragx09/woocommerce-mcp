#!/usr/bin/env node
// Builds tracker/data.js from the project's Markdown files.
// Zero dependencies. Run: npm run tracker
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '');
const warnings = [];

// ---------- helpers ----------
function sections(md, level) {
  // Split markdown into sections at headings of exactly `level`.
  const re = new RegExp(`^${'#'.repeat(level)} (.+)$`, 'gm');
  const out = [];
  let m, last = null;
  while ((m = re.exec(md))) {
    if (last) last.body = md.slice(last.start, m.index);
    last = { title: m[1].trim(), start: re.lastIndex };
    out.push(last);
  }
  if (last) last.body = md.slice(last.start);
  return out.map(({ title, body }) => ({ title, body: body || '' }));
}

function fields(body) {
  // Parse "- **Field:** value" bullets (value may continue on indented lines).
  const out = {};
  let key = null;
  for (const line of body.split('\n')) {
    const m = line.match(/^- \*\*([^*]+?):\*\*\s?(.*)$/);
    if (m) { key = m[1].trim(); out[key] = m[2].trim(); continue; }
    if (key && /^\s{2,}\S/.test(line)) out[key] += ' ' + line.trim();
    else if (line.trim() === '' || /^(#|---)/.test(line)) key = null;
  }
  return out;
}

function tables(md) {
  // Return all markdown tables as arrays of row objects keyed by header.
  const lines = md.split('\n');
  const result = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^\|.*\|\s*$/.test(lines[i]) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const split = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = split(lines[i]);
      const rows = [];
      let j = i + 2;
      for (; j < lines.length && /^\|.*\|\s*$/.test(lines[j]); j++) {
        const cells = split(lines[j]);
        rows.push(Object.fromEntries(head.map((h, k) => [h, cells[k] ?? ''])));
      }
      result.push({ head, rows, line: i });
      i = j;
    }
  }
  return result;
}

function sectionText(md, heading) {
  const s = sections(md, 2).find((x) => x.title.toLowerCase().startsWith(heading.toLowerCase()));
  return s ? s.body.trim() : '';
}

const idList = (s) => (s || '').match(/\b(?:P0|ARC|INF|WC|GW|AUTH|UI|E2E|REL|BON)-\d{2}(?:\.\.(?:(?:P0|ARC|INF|WC|GW|AUTH|UI|E2E|REL|BON)-)?\d{2})?\b/g) || [];

// ---------- TASKS.md ----------
const tasksMd = read('TASKS.md');
const phases = [];
const tasks = [];
for (const ph of sections(tasksMd, 2)) {
  const pm = ph.title.match(/^Phase (\d+) — (.+)$/);
  if (!pm) continue;
  const exit = (ph.body.match(/^Exit criterion:\s*(.+)$/m) || [])[1] || '';
  const phase = { num: Number(pm[1]), name: pm[2], exit, taskIds: [] };
  phases.push(phase);
  for (const t of sections(ph.body, 3)) {
    const tm = t.title.match(/^([A-Z0-9]+-\d{2}) — (.+)$/);
    if (!tm) { warnings.push(`TASKS.md: unparsed task heading "${t.title}"`); continue; }
    const f = fields(t.body);
    const task = {
      id: tm[1], title: tm[2], phase: phase.num,
      priority: f['Priority'] || '', status: f['Status'] || 'Not Started', day: f['Day'] || '',
      dependsOn: f['Depends on'] || '', requirements: f['Requirements'] || '',
      description: f['Description'] || '', output: f['Output'] || '', acceptance: f['Acceptance'] || '',
      tests: f['Tests'] || '', command: f['Command'] || '', evidence: f['Evidence'] || '',
      risk: f['Regression risk'] || '',
    };
    for (const req of ['Priority', 'Status', 'Day', 'Acceptance', 'Tests'])
      if (!f[req]) warnings.push(`${task.id}: missing field "${req}"`);
    if (!['Not Started', 'In Progress', 'Blocked', 'Done'].includes(task.status))
      warnings.push(`${task.id}: unknown status "${task.status}"`);
    if (task.status === 'Done' && (!task.evidence || task.evidence === '—'))
      warnings.push(`${task.id}: marked Done without evidence`);
    tasks.push(task);
    phase.taskIds.push(task.id);
  }
}
const taskById = Object.fromEntries(tasks.map((t) => [t.id, t]));

// Expand dependency ranges like "P0-01..P0-11" or "WC-08..WC-12".
function expandIds(s) {
  const out = [];
  for (const tok of idList(s)) {
    const r = tok.match(/^([A-Z0-9]+)-(\d{2})\.\.(?:([A-Z0-9]+)-)?(\d{2})$/);
    if (r) { for (let n = +r[2]; n <= +r[4]; n++) out.push(`${r[1]}-${String(n).padStart(2, '0')}`); }
    else out.push(tok);
  }
  return out;
}
for (const t of tasks) {
  t.deps = expandIds(t.dependsOn).filter((d) => d !== t.id);
  for (const d of t.deps) if (!taskById[d]) warnings.push(`${t.id}: depends on unknown task ${d}`);
  t.ready = t.status === 'Not Started' && t.deps.every((d) => taskById[d]?.status === 'Done');
}

const schedule = (tables(sectionText(tasksMd, 'Schedule'))[0]?.rows || []).map((r) => ({
  day: r['Day'], date: r['Date'], focus: r['Focus'], gate: r['Exit gate'],
}));
const bonus = [...sectionText(tasksMd, 'Bonus').matchAll(/^- \*\*(BON-\d{2})\*\*\s*(.+)$/gm)].map((m) => ({ id: m[1], text: m[2] }));

// ---------- Traceability ----------
const traceMd = read('docs/REQUIREMENTS_TRACEABILITY.md');
const traceTable = tables(traceMd).find((t) => t.head.includes('ReqID'));
const requirements = (traceTable?.rows || []).map((r) => ({
  id: r['ReqID'], section: r['Section'], text: r['Requirement'], component: r['Component'],
  tasks: expandIds(r['Tasks']), tests: r['Tests'], status: r['Status'], evidence: r['Evidence'],
}));
const specMd = read('SPEC.md');
const specReqs = [...specMd.matchAll(/^- \*\*(REQ-[A-Z0-9]+-\d{2})\*\*\s*(.+)$/gm)].map((m) => ({ id: m[1], text: m[2] }));
const traceIds = new Set(requirements.map((r) => r.id));
const unmapped = specReqs.filter((r) => !traceIds.has(r.id)).map((r) => r.id);
for (const id of unmapped) warnings.push(`${id}: in SPEC.md but missing from traceability matrix`);
for (const r of requirements) {
  r.specText = specReqs.find((s) => s.id === r.id)?.text || '';
  r.gaps = [];
  if (!r.tasks.length) r.gaps.push('no task');
  if (!r.tests || r.tests === '—') r.gaps.push('no test');
  for (const t of r.tasks) if (!taskById[t]) r.gaps.push(`unknown task ${t}`);
  r.taskStatuses = r.tasks.map((t) => taskById[t]?.status || 'Unknown');
  r.tasksDone = r.taskStatuses.filter((s) => s === 'Done').length;
}

// ---------- PROGRESS.md ----------
const progMd = read('docs/PROGRESS.md');
const progress = {};
for (const s of sections(progMd, 2)) progress[s.title] = s.body.trim();
const risks = (tables(progress['Risks'] || '')[0]?.rows || []).map((r) => ({
  id: r['#'], risk: r['Risk'], mitigation: r['Mitigation'], owner: r['Owner task'],
}));

// ---------- DECISIONS.md ----------
const decisions = sections(read('DECISIONS.md'), 2)
  .map((s) => {
    const m = s.title.match(/^(D-\d{3}) — (.+)$/);
    if (!m) return null;
    const f = fields(s.body);
    return { id: m[1], title: m[2], date: f['Date'] || '', status: f['Status'] || '', context: f['Context'] || '',
      options: f['Options'] || '', choice: f['Choice'] || '', why: f['Why'] || '', tradeoffs: f['Trade-offs'] || '', revisit: f['Revisit'] || '' };
  })
  .filter(Boolean);

// ---------- Concepts ----------
const conceptRows = tables(read('knowledge/CONCEPTS_INDEX.md'))[0]?.rows || [];
const concepts = conceptRows.map((r) => ({ concept: r['Concept'], status: r['Status'], note: r['Note'], tasks: r['Tasks'] }));

// ---------- Overview (SPEC + ARCHITECTURE) ----------
const archMd = read('ARCHITECTURE.md');
const overview = {
  problem: sectionText(specMd, '1. Problem'),
  roles: tables(sectionText(specMd, '2. Users'))[0]?.rows || [],
  workflows: sectionText(specMd, '3. Workflows'),
  assumptions: sectionText(specMd, '9. Assumptions'),
  layers: tables(sectionText(archMd, '1. Layers'))[0]?.rows || [],
  diagram: (sectionText(archMd, '2. Component diagram').match(/```mermaid\n([\s\S]*?)```/) || [])[1] || '',
  publicInternal: tables(sectionText(archMd, '3. Public'))[0]?.rows || [],
  mission: (read('CLAUDE.md').match(/## Mission\n([\s\S]*?)\n\n/) || [])[1] || '',
};

// ---------- Docs (full text for the in-page reader) ----------
const docFiles = [];
const walk = (dir) => {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (['node_modules', '.git', 'tracker'].includes(name)) continue;
    const rel = dir ? `${dir}/${name}` : name;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) walk(rel);
    else if (name.endsWith('.md')) docFiles.push(rel);
  }
};
walk('');
const order = ['README.md', 'problem-statement.md', 'SPEC.md', 'ARCHITECTURE.md', 'TASKS.md', 'TEST_PLAN.md', 'DECISIONS.md', 'THREAT_MODEL.md', 'CLAUDE.md'];
docFiles.sort((a, b) => {
  const ia = order.indexOf(a), ib = order.indexOf(b);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a.localeCompare(b);
});
const docs = docFiles.map((p) => ({ path: p, content: read(p), mtime: statSync(join(ROOT, p)).mtime.toISOString() }));

// ---------- Summary ----------
const count = (arr, pred) => arr.filter(pred).length;
const summary = {
  tasks: tasks.length,
  byStatus: Object.fromEntries(['Done', 'In Progress', 'Blocked', 'Not Started'].map((s) => [s, count(tasks, (t) => t.status === s)])),
  p0: { total: count(tasks, (t) => t.priority === 'P0'), done: count(tasks, (t) => t.priority === 'P0' && t.status === 'Done') },
  requirements: requirements.length,
  reqVerified: count(requirements, (r) => r.status === 'Verified'),
  reqGaps: count(requirements, (r) => r.gaps.length > 0),
  unmapped: unmapped.length,
};

const data = {
  generatedAt: new Date().toISOString(),
  project: { name: 'WooCommerce Hosting + Team MCP Gateway', start: '2026-10-11', deadline: '2026-10-17' },
  summary, phases, tasks, schedule, bonus, requirements, progress, risks, decisions, concepts, overview, docs, warnings,
};

writeFileSync(join(ROOT, 'tracker/data.js'), `// Generated by tracker/build.mjs — do not edit by hand.\nwindow.TRACKER_DATA = ${JSON.stringify(data)};\n`);

console.log(`tracker/data.js written (${relative(ROOT, join(ROOT, 'tracker/data.js'))})`);
console.log(`  tasks: ${summary.tasks}  done: ${summary.byStatus.Done}  in progress: ${summary.byStatus['In Progress']}  blocked: ${summary.byStatus.Blocked}`);
console.log(`  P0 done: ${summary.p0.done}/${summary.p0.total}`);
console.log(`  requirements: ${summary.requirements}  verified: ${summary.reqVerified}  with gaps: ${summary.reqGaps}  unmapped in SPEC: ${summary.unmapped}`);
console.log(`  decisions: ${decisions.length}  concepts: ${concepts.length}  docs: ${docs.length}`);
if (warnings.length) {
  console.log(`  warnings (${warnings.length}):`);
  for (const w of warnings) console.log(`   - ${w}`);
}
