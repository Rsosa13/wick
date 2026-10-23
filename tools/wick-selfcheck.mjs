#!/usr/bin/env node
// ─── wick-selfcheck — stepwise retrieval and superseded facts, checked end to end ──
// Wick has no test framework and wants none: zero dependencies is a feature. This builds throwaway memory layers in
// the OS temp directory, runs the real CLIs against them the way a person does, and checks what they print and what
// they leave on disk. No network, no model: wick-ask runs with --dry.
//
// What it checks:
//   1. backward compatibility: memory with no tag in it reads byte for byte as before, and the old flags still work
//   2. entries: a dated bullet is an entry, a dated FIELD is not, a template's example is not, a quoted tag is not live
//   3. supersede: the new fact is written, the old one marked with a date and a pointer, nothing is deleted, the stamp
//      and index row move, and every refusal leaves the disk exactly as it was
//   4. hidden by default: routing, --index, --get and wick-ask skip a superseded entry; --include-superseded shows it
//   5. size: on a large generated memory set, step 1 stays a few lines however big memory gets
//
// Exit 0 = every check passed, 1 = a check failed.
//   node tools/wick-selfcheck.mjs
//   node tools/wick-selfcheck.mjs --keep     leave the temp layers on disk to look at

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { entries, activeText } from './wick-recall.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const keep = process.argv.includes('--keep');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wick-selfcheck-'));
const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const ON = '2026-09-30';                         // the supersede date used throughout: in the past for any real clock

let passed = 0, failed = 0;
const check = (name, ok, why = '') => {
  if (ok) passed++; else failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !why ? '' : '\n      ' + String(why).trim().split('\n').join('\n      ')}`);
};
const run = (tool, args, mem, cwd = ROOT) => {
  const r = spawnSync(process.execPath, [path.join(HERE, tool), ...args],
                      { cwd, encoding: 'utf8', env: { ...process.env, WICK_MEMORY: mem } });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};
const put = (dir, files) => {
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), t);
  }
  return dir;
};
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const snap = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map(f => [f, read(dir, f)]));
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []);
const rows = (out) => out.split('\n').filter(l => l.startsWith('  '));
// Nothing deleted: every line of the file before, in order, is still there after, once the appended tags are taken
// off. The stamp's date is the one field that is allowed to move.
const norm = (l) => l.replace(/\s*\[(?:superseded|supersedes):[^\]]*\]/g, '').replace(/^\*Updated: \d{4}-\d{2}-\d{2}/, '*Updated: D');
const kept = (before, after) => {
  const a = after.split('\n').map(norm);
  let j = 0;
  for (const l of before.split('\n').map(norm)) {
    while (j < a.length && a[j] !== l) j++;
    if (j++ === a.length) return false;
  }
  return true;
};

// ─── the fixture: an ordinary memory layer with no tags, the shape the templates teach ─────────────────
const FIXTURE = {
  'index.md': `# Memory Index

*Updated: 2026-08-01 · first written 2026-08-01*

## Core
- [learning-journal](learning-journal.md) — how this person works: preferences, corrections (2026-08-03)
- [decisions](decisions.md) — dated decision log: billing, hosting, what we decided and why (2026-09-01)
- [domain-knowledge](domain-knowledge.md) — field terms and definitions: churn, runway (2026-08-03)
`,
  'learning-journal.md': `# Learning Journal

*Updated: 2026-08-03 · first written 2026-04-20*

What Wick has learned about working with you.

## Preferences Discovered
- [2026-05-02] prefers brief answers with the number first
- [2026-06-11] wants citations named inline, never as footnotes

## Corrections Given
<!-- These are the most valuable entries. -->
- [2026-07-19] the staging database is read-only on weekends; never propose
  a migration for a Saturday
`,
  'decisions.md': `# Decision Log

*Updated: 2026-09-01 · first written 2026-04-20*

Decisions made with Wick, logged with framework citations and dates.

---

<!-- Template for new entries:

### YYYY-MM-DD — [Decision Title]
- **Context:** What prompted this decision

-->

### 2026-06-02 — Monthly billing for the starter tier
- **Context:** churn on annual plans during the pilot
- **Decision:** bill the starter tier every month
- **Review date:** 2026-12-01

### 2026-09-01 — Hosting stays on the single VPS
- **Context:** traffic is flat
- **Decision:** no move to managed hosting this year

---
*Wick appends to this file after each /decide session.*
`,
  'domain-knowledge.md': `# Domain Knowledge

*Updated: 2026-08-03 · first written 2026-04-20*

## Subscription metrics

### Key Concepts
- **Churn** *[2026-03-03]* — share of accounts lost per month
- **Churn** *[2026-09-09]* — share of revenue lost per month, net of expansion
- **Runway** *[2026-04-04]* — months of cash at the current burn
`,
};
const LJ_OLD = 'learning-journal.md#2026-05-02-prefers-brief-answers-with-the-number-first';
// An id is the title slugged to at most 10 words and 64 characters, so a long title is cut ("...-that-shows-the").
const LJ_NEW = `learning-journal.md#${ON}-prefers-a-short-paragraph-that-shows-the`;
const DEC_MID = 'decisions.md#2026-06-02-monthly-billing-for-the-starter-tier';
const DEC_LAST = 'decisions.md#2026-09-01-hosting-stays-on-the-single-vps';
const CHURN_OLD = 'domain-knowledge.md#churn-2026-03-03-share-of-accounts-lost-per-month';
const CHURN_NEW = 'domain-knowledge.md#churn-2026-09-09-share-of-revenue-lost-per-month';

console.log(`wick-selfcheck — stepwise retrieval + superseded facts   (temp: ${TMP})`);

// ─── 1. backward compatibility ─────────────────────────────────────────────
console.log('\n1. backward compatibility (memory with no tags)');
const shipped = path.join(ROOT, 'memory');
const plain = put(path.join(TMP, 'plain'), FIXTURE);
{
  const all = [...walk(shipped).map(p => [shipped, p]), ...walk(plain).map(p => [plain, p])];
  const changed = all.filter(([d, p]) => { const t = fs.readFileSync(p, 'utf8'); return activeText(path.relative(d, p), t) !== t; });
  check(`activeText returns every untagged file byte for byte (${all.length} files: the shipped templates + the fixture)`,
        all.length > 10 && !changed.length, changed.map(([, p]) => p).join('\n'));

  const queries = ['how do I handle a flaky prediction?', 'what did we decide about billing?', 'brier score calibration',
                   'which machine toolchain', 'corrections preferences', 'churn runway definitions', 'hosting VPS'];
  const diff = [];
  for (const mem of [shipped, plain]) {
    for (const q of queries) {
      for (const extra of [[], ['-k', '3']]) {
        const a = run('wick-recall.mjs', [...extra, q], mem), b = run('wick-recall.mjs', [...extra, '--include-superseded', q], mem);
        if (a.out !== b.out || a.code !== 0) diff.push(`wick-recall ${extra.join(' ')} "${q}" on ${path.basename(path.dirname(mem))}/${path.basename(mem)}`);
      }
      const a = run('wick-ask.mjs', ['--dry', q], mem), b = run('wick-ask.mjs', ['--dry', '--include-superseded', q], mem);
      if (a.out !== b.out || a.code !== 0) diff.push(`wick-ask --dry "${q}"`);
    }
  }
  check(`untagged memory routes and answers the same with and without --include-superseded (${queries.length * 2 * 3} runs)`,
        !diff.length, diff.join('\n'));

  const top = run('wick-recall.mjs', ['billing hosting decided'], plain);
  check('the default router still names files (decisions.md first for "billing hosting decided")',
        rows(top.out)[0]?.trim().startsWith('decisions.md'), top.out + top.err);
  const one = run('wick-recall.mjs', ['-k', '1', 'preferences corrections billing churn'], plain);
  check('-k still caps the rows (-k 1 prints one)', rows(one.out).length === 1, one.out);
  const bare = run('wick-recall.mjs', [], plain);
  check('no query still prints the usage and exits 1',
        bare.code === 1 && bare.out.startsWith('usage: node tools/wick-recall.mjs [-k N]'), bare.out);
  const gone = run('wick-recall.mjs', ['anything'], path.join(TMP, 'no-such-memory'));
  check('unreachable memory still exits 2 and never says "(no match)"',
        gone.code === 2 && !gone.out.includes('no match'), gone.out + gone.err);
  const typo = run('wick-recall.mjs', ['--include-supersede', 'billing'], plain);
  check('a mistyped flag is an error (exit 2), not a word of the query', typo.code === 2, typo.out + typo.err);
}

// ─── 2. entries ────────────────────────────────────────────────────────────
console.log('\n2. entries');
{
  const lj = entries('learning-journal.md', FIXTURE['learning-journal.md']);
  const wrap = lj.find(e => e.id === 'learning-journal.md#2026-07-19-the-staging-database-is-read-only-on');
  check('a dated bullet is an entry, and its wrapped line stays with it',
        lj.some(e => e.id === LJ_OLD) && !!wrap && wrap.text.includes('a migration for a Saturday'), lj.map(e => e.id).join('\n'));
  const dec = entries('decisions.md', FIXTURE['decisions.md']);
  const mid = dec.find(e => e.id === DEC_MID);
  check('a dated FIELD (- **Review date:** ...) stays inside its decision, not split off',
        !!mid && mid.text.includes('Review date') && !dec.some(e => /review-date/.test(e.id)), dec.map(e => e.id).join('\n'));
  check('a template example inside an HTML comment is not an entry', !dec.some(e => /yyyy/.test(e.id)), dec.map(e => e.id).join('\n'));
  const dk = entries('domain-knowledge.md', FIXTURE['domain-knowledge.md']);
  check('domain-knowledge\'s "- **Term** *[date]*" bullets are entries, and two of one term get two ids',
        dk.some(e => e.id === CHURN_OLD) && dk.some(e => e.id === CHURN_NEW), dk.map(e => e.id).join('\n'));
  const quoted = entries('x.md', '- [2026-01-01] write `[superseded: 2026-01-02 → x.md#y]` to retire a fact\n')[0];
  const live = entries('x.md', '- [2026-01-01] the old fact [superseded: 2026-01-02 → x.md#y]\n')[0];
  check('a tag inside a code span is documentation, not a tag; an unquoted one is live',
        quoted && !quoted.superseded && live?.superseded?.date === '2026-01-02' && live.superseded.by === 'x.md#y');
  const sec = '# X\n\n## Old plan [superseded: 2026-01-02 → x.md#new-plan]\nthe plan\n- [2026-01-01] a dated note under it\n\n## New plan\nthe new plan\n';
  const se = entries('x.md', sec), act = activeText('x.md', sec);
  check('a tag on a heading retires the whole section under it, dated bullets included',
        se.find(e => e.id === 'x.md#2026-01-01-a-dated-note-under-it')?.superseded?.inherited === true &&
        !act.includes('a dated note') && !act.includes('Old plan') && act.includes('the new plan') &&
        act.split('\n').length === sec.split('\n').length, act);
}

// ─── 3. supersede ──────────────────────────────────────────────────────────
console.log('\n3. supersede: the new fact written, the old one marked, nothing deleted');
const flowRoot = path.join(TMP, 'flow'), flow = put(path.join(flowRoot, 'memory'), FIXTURE);
{
  const before = snap(flow);
  const r = run('wick-supersede.mjs', [LJ_OLD, 'prefers a short paragraph that shows the reasoning', '--date', ON], flow);
  const after = read(flow, 'learning-journal.md'), lines = after.split('\n');
  const at = lines.findIndex(l => l.startsWith('- [2026-05-02]'));
  check('supersede a dated bullet: exit 0', r.code === 0, r.out + r.err);
  check('the old bullet keeps its words and gains [superseded: <date> → <new id>]',
        lines[at] === `- [2026-05-02] prefers brief answers with the number first [superseded: ${ON} → ${LJ_NEW}]`, lines[at]);
  check('the new bullet is written straight after it, same shape, pointing back',
        lines[at + 1] === `- [${ON}] prefers a short paragraph that shows the reasoning [supersedes: ${LJ_OLD}]`, lines[at + 1]);
  check('nothing was deleted: every earlier line is still there, in order', kept(before['learning-journal.md'], after));
  const stamp = after.match(/^\*Updated: (\d{4}-\d{2}-\d{2})/m)?.[1];
  const row = read(flow, 'index.md').match(/learning-journal\.md\).*\((\d{4}-\d{2}-\d{2})\)/)?.[1];
  check(`the file's Updated stamp and its index.md row both moved to today (${TODAY})`, stamp === TODAY && row === TODAY, `${stamp} / ${row}`);

  const r2 = run('wick-supersede.mjs', [DEC_LAST, 'Hosting moves to managed containers', '--date', ON], flow);
  const d2 = read(flow, 'decisions.md'), dl = d2.trimEnd().split('\n');
  const newHead = `### ${ON} — Hosting moves to managed containers`;
  const at2 = dl.indexOf(newHead);
  check('supersede the last decision: a heading of the same shape, a "Replaces:" line carrying the pointer, above the footer',
        r2.code === 0 && at2 > 0 && dl[at2 + 1] === `- **Replaces:** 2026-09-01 — Hosting stays on the single VPS [supersedes: ${DEC_LAST}]` &&
        at2 < dl.lastIndexOf('---') && dl[dl.length - 1] === '*Wick appends to this file after each /decide session.*', r2.err + d2);
  const r3 = run('wick-supersede.mjs', [DEC_MID, 'Annual billing for the starter tier', '--date', ON], flow);
  const d3 = read(flow, 'decisions.md').split('\n');
  const h3 = d3.findIndex(l => l.startsWith(`### ${ON} — Annual billing`));
  check('supersede a middle decision: the new one sits after the old one\'s last field, before the next decision',
        r3.code === 0 && h3 > d3.findIndex(l => l.includes('**Review date:**')) && h3 < d3.findIndex(l => l.startsWith('### 2026-09-01')) &&
        d3[h3 - 1] === '' && d3[h3 + 1].startsWith('- **Replaces:** 2026-06-02') && d3[h3 + 2] === '', r3.err + d3.join('\n'));
  check('nothing was deleted from decisions.md across both', kept(before['decisions.md'], read(flow, 'decisions.md')));

  const r4 = run('wick-supersede.mjs', [CHURN_OLD, '--by', CHURN_NEW, '--date', ON], flow);
  const dk = entries('domain-knowledge.md', read(flow, 'domain-knowledge.md'));
  check('--by links two existing entries: the old marked, the new pointing back, no new text written',
        r4.code === 0 && dk.find(e => e.id === CHURN_OLD)?.superseded?.by === CHURN_NEW &&
        dk.find(e => e.id === CHURN_NEW)?.supersedes === CHURN_OLD && dk.length === entries('d', FIXTURE['domain-knowledge.md']).length,
        r4.out + r4.err);

  const fresh = run('wick-freshness-audit.mjs', [], flow, flowRoot);
  if (TODAY > new Date().toISOString().slice(0, 10)) {
    console.log('  - wick-freshness-audit skipped: the local date is ahead of UTC, which that audit reads as "future"');
  } else {
    check('wick-freshness-audit passes on the layer afterwards (stamps and index rows agree)', fresh.code === 0, fresh.out + fresh.err);
  }

  const held = snap(flow);
  const refusals = [
    ['an unknown id', ['learning-journal.md#no-such-entry', 'x'], 2],
    ['an id that climbs out of memory/', ['../outside.md#x', 'x'], 2],
    ['an index.md id', ['index.md#core', 'x'], 2],
    ['an entry that is already superseded', [LJ_OLD, 'again'], 1],
    ['a date in the future', [`learning-journal.md#2026-06-11-wants-citations-named-inline-never-as-footnotes`, 'x', '--date', '2999-01-01'], 1],
    ['both a new fact and --by', [LJ_NEW, 'x', '--by', LJ_OLD], 2],
    ['--dry', ['learning-journal.md#2026-06-11-wants-citations-named-inline-never-as-footnotes', 'cites with links'], 0, ['--dry']],
  ];
  const bad = [];
  for (const [what, a, code, extra = []] of refusals) {
    const x = run('wick-supersede.mjs', [...a, ...extra], flow);
    if (x.code !== code) bad.push(`${what}: exit ${x.code}, expected ${code}\n${x.out}${x.err}`);
  }
  const same = JSON.stringify(snap(flow)) === JSON.stringify(held);
  check(`every refusal exits as documented and --dry writes nothing; the disk is byte-identical after all ${refusals.length}`,
        !bad.length && same, bad.join('\n') + (same ? '' : '\nthe disk changed'));

  // Superseding must never rename an existing entry: a new fact whose slug equals a LATER entry's would push that one
  // to "-2" and break every pointer to it.
  const col = put(path.join(TMP, 'collide'), { 'c.md': `# C\n\n- [2026-01-01] the old fact\n- [${ON}] same words here\n` });
  const c0 = read(col, 'c.md');
  const c = run('wick-supersede.mjs', ['c.md#2026-01-01-the-old-fact', 'same words here', '--date', ON], col);
  check('a new entry that would rename an existing one is refused (exit 1) and nothing is written',
        c.code === 1 && read(col, 'c.md') === c0, c.out + c.err);

  const crlf = put(path.join(TMP, 'crlf'), { 'l.md': '# L\r\n\r\n*Updated: 2026-01-01 · first written 2026-01-01*\r\n\r\n- [2026-01-01] old\r\n- [2026-01-02] other\r\n' });
  const w = run('wick-supersede.mjs', ['l.md#2026-01-01-old', 'new', '--date', ON], crlf);
  const lt = read(crlf, 'l.md');
  check('a CRLF file stays CRLF', w.code === 0 && !/[^\r]\n/.test(lt) && lt.includes(`- [${ON}] new [supersedes: l.md#2026-01-01-old]\r\n`), lt);
}

// ─── 4. hidden by default ──────────────────────────────────────────────────
console.log('\n4. superseded entries are hidden by default, and one flag away');
{
  const q = 'preferences brief answers number first';
  const i0 = run('wick-recall.mjs', ['--index', q], flow), i1 = run('wick-recall.mjs', ['--index', '--include-superseded', q], flow);
  check('--index leaves the superseded entry out and lists its replacement', !i0.out.includes(LJ_OLD) && i0.out.includes(LJ_NEW), i0.out);
  check('--index --include-superseded lists it, marked', i1.out.includes(LJ_OLD) && i1.out.includes(`[superseded ${ON} →`), i1.out);

  // "monthly" lived only in the superseded decision's heading, so it was only ever on the routing surface through it.
  const r0 = run('wick-recall.mjs', ['monthly'], flow), r1 = run('wick-recall.mjs', ['--include-superseded', 'monthly'], flow);
  check('the router stops routing on a superseded heading, and routes on it again with the flag',
        !r0.out.includes('decisions.md') && r1.out.includes('decisions.md'), r0.out + '\n--\n' + r1.out);

  const g0 = run('wick-recall.mjs', ['--get', LJ_OLD], flow), g1 = run('wick-recall.mjs', ['--get', '--include-superseded', LJ_OLD], flow);
  check('--get on a superseded id says so and returns the replacement instead',
        g0.code === 0 && g0.out.includes(`was superseded on ${ON}`) && g0.out.includes(`── ${LJ_NEW}`) && !g0.out.includes(`── ${LJ_OLD}`), g0.out + g0.err);
  check('--get --include-superseded returns the old entry itself, marked',
        g1.code === 0 && g1.out.includes(`── ${LJ_OLD}`) && g1.out.includes('[SUPERSEDED'), g1.out);
  const gm = run('wick-recall.mjs', ['--get', LJ_NEW, 'learning-journal.md#no-such-entry'], flow);
  check('--get with an unknown id prints what it found and exits 2', gm.code === 2 && gm.out.includes(`── ${LJ_NEW}`), gm.out + gm.err);

  const a0 = run('wick-ask.mjs', ['--dry', q], flow), a1 = run('wick-ask.mjs', ['--dry', '--include-superseded', q], flow);
  check('wick-ask never offers the superseded text as a source; --include-superseded does',
        a0.out.includes('learning-journal.md') && !a0.out.includes('with the number first') && a1.out.includes('with the number first'),
        a0.out + '\n--\n' + a1.out);
  const h0 = run('wick-ask.mjs', ['--dry', 'what did we decide about hosting?'], flow);
  check('wick-ask reads the decision that replaced a superseded one (and not the old one)',
        h0.out.includes('Hosting moves to managed containers') && !h0.out.includes('no move to managed hosting'), h0.out);
}

// ─── 5. size ───────────────────────────────────────────────────────────────
console.log('\n5. step 1 stays small on a large memory set');
{
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const V = ('ledger invoice vendor contract renewal budget forecast audit payroll hiring onboarding roadmap release ' +
    'migration outage latency cache queue backlog sprint review retro pricing discount churn cohort funnel trial ' +
    'upgrade refund dispute compliance policy privacy consent backup restore schema index replica shard region ' +
    'deploy rollback canary flag experiment metric dashboard alert pager incident postmortem runbook escalation ' +
    'partner reseller channel campaign launch webinar newsletter survey interview persona segment territory quota ' +
    'pipeline deal proposal negotiation signature invoice tax filing quarter annual monthly weekly standup offsite').split(' ');
  const sentence = () => Array.from({ length: 8 + rnd(7) }, () => V[rnd(V.length)]).join(' ');
  const date = () => `2026-${String(1 + rnd(9)).padStart(2, '0')}-${String(1 + rnd(28)).padStart(2, '0')}`;
  const F = 120, E = 250, big = {};
  const idx = ['# Memory Index', '', '*Updated: 2026-08-01 · first written 2026-08-01*', '', '## Logs'];
  for (let f = 1; f <= F; f++) {
    const name = `log-${String(f).padStart(3, '0')}.md`;
    big[name] = [`# Log ${f}`, '', '*Updated: 2026-08-01 · first written 2026-01-01*', '', '## Entries',
                 ...Array.from({ length: E }, () => `- [${date()}] ${sentence()}`)].join('\n') + '\n';
    idx.push(`- [log-${f}](${name}) — ${V[rnd(V.length)]}, ${V[rnd(V.length)]} and ${V[rnd(V.length)]} notes (2026-08-01)`);
  }
  // One long file with a fact buried near the top: §13 measured 0% recall across the first 70% of a 551-line file
  // read whole. Step 2 hands back that one entry instead of the file.
  const kiln = Array.from({ length: 600 }, () => `- [${date()}] ${sentence()}`);
  kiln[50] = '- [2026-02-14] the kiln thermocouple reads 40 degrees low; add 40 to every logged temperature';
  big['kiln-log.md'] = ['# Kiln log', '', '*Updated: 2026-08-01 · first written 2026-01-01*', '', ...kiln].join('\n') + '\n';
  idx.push('- [kiln-log](kiln-log.md) — kiln firing log: temperatures, cones, schedules (2026-08-01)');
  big['index.md'] = idx.join('\n') + '\n';
  const large = put(path.join(TMP, 'large'), big);

  const bytes = Object.values(big).reduce((s, t) => s + Buffer.byteLength(t), 0);
  const all = Object.entries(big).filter(([f]) => f !== 'index.md').flatMap(([f, t]) => entries(f, t));
  const naive = all.reduce((s, e) => s + Buffer.byteLength(`  ${e.id}   0.00  ${e.desc}\n`), 0);
  const BOUND = 2048, sizes = [];
  let worst = 0, over = [];
  for (const q of ['pricing discount churn cohort', 'outage postmortem runbook pager', 'kiln thermocouple temperature offset',
                   'vendor contract renewal signature', 'what did we decide about the hiring budget?']) {
    const t0 = Date.now(), r = run('wick-recall.mjs', ['--index', q], large), ms = Date.now() - t0;
    const b = Buffer.byteLength(r.out), n = r.out.trimEnd().split('\n').length;
    sizes.push(`${b} B / ${n} lines / ${ms} ms  "${q}"`);
    worst = Math.max(worst, b);
    // A question that no index row or heading matches routes nowhere (the router reads index rows and headings, not
    // bullet prose) and prints one line. Every other question must print exactly 8 rows.
    const none = r.out.startsWith('(no match');
    if (r.code !== 0 || b > BOUND || n > 8 + 2 || (!none && rows(r.out).length !== 8)) over.push(`${q}: exit ${r.code}, ${b} B, ${n} lines\n${r.out}${r.err}`);
  }
  check(`${all.length.toLocaleString('en-US')} entries in ${F + 1} files (${(bytes / 1048576).toFixed(1)} MB): --index printed at most ` +
        `${worst.toLocaleString('en-US')} bytes, 8 rows (bound ${BOUND.toLocaleString('en-US')}); one row per entry for the whole layer ` +
        `would be ${(naive / 1048576).toFixed(1)} MB`, !over.length, over.join('\n'));
  for (const s of sizes) console.log(`      ${s}`);
  const n3 = run('wick-recall.mjs', ['--index', '-n', '3', 'pricing discount'], large);
  check('-n caps step 1 (-n 3 prints three rows)', rows(n3.out).length === 3, n3.out);

  const needle = 'kiln-log.md#2026-02-14-the-kiln-thermocouple-reads-40-degrees-low';
  const ki = run('wick-recall.mjs', ['--index', 'kiln thermocouple temperature offset'], large);
  const kg = run('wick-recall.mjs', ['--get', needle], large);
  check('a fact at line 55 of a 604-line file is the top row of step 1, and step 2 returns just that entry',
        rows(ki.out)[0]?.trim().startsWith(needle) && kg.code === 0 && kg.out.includes('reads 40 degrees low') &&
        Buffer.byteLength(kg.out) < 300, ki.out + '\n--\n' + kg.out + kg.err);
}

if (!keep) fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n  ${passed} passed, ${failed} failed${keep ? `   (kept: ${TMP})` : ''}`);
process.exit(failed ? 1 : 0);
