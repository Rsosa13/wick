#!/usr/bin/env node
// ─── wick-supersede — a fact that changed is marked, never deleted ──────────
// When something memory holds stops being true, the honest record is not an edit that erases it. It is the new fact,
// written beside the old one, and the old one marked with the day it stopped holding and where its replacement lives:
//   old entry  gains  [superseded: <date> → <new id>]     its words are otherwise untouched
//   new entry  gains  [supersedes: <old id>]              written straight after the old one, in the same shape
// The file's `Updated:` stamp and its index.md row move to today, as MEMORY-PROTOCOL.md §10 asks of any content change.
//
// WHY NOT JUST EDIT. An overwritten fact cannot be audited: nobody can see what was believed, when it changed, or
// whether a decision made in between rested on the old version. Graphiti and Hindsight, too, mark a replaced fact
// invalid rather than delete it. Wick was already append-only (CLAUDE.md, "Append, don't overwrite"); this gives the
// append a pointer, so retrieval can tell the current fact from the history. wick-recall and wick-ask leave
// superseded entries out by default and read them with --include-superseded.
//
// IT NEVER DECIDES THAT A FACT IS STALE. It records a decision someone made, with the replacement in hand. Age is not
// a reason (§10: a date is a recall aid, never an expiry); a contradiction is.
//
// Zero dependencies. Node >= 18. Exit 0 = written (or shown, with --dry), 1 = refused and nothing written,
// 2 = bad usage, or an id or file that cannot be read.
//   node tools/wick-supersede.mjs <old-id> "<the new fact>"          write the new entry, mark the old one
//   node tools/wick-supersede.mjs <old-id> --by <new-id>             the new entry exists already: link the two
//   node tools/wick-supersede.mjs <old-id> "<the new fact>" --dry    print what would change, write nothing
//   --date YYYY-MM-DD    the day the old fact stopped holding, and the new one's date (default: today, local time)
// Ids come from `node tools/wick-recall.mjs --index "<question>"`. WICK_MEMORY=<dir> points it at another layer.

import fs from 'node:fs';
import path from 'node:path';
import { MEM, entries, SUPERSEDED } from './wick-recall.mjs';

const usage = 'usage: node tools/wick-supersede.mjs <old-id> "<the new fact>" [--date YYYY-MM-DD] [--dry]\n' +
              '       node tools/wick-supersede.mjs <old-id> --by <new-id> [--date YYYY-MM-DD] [--dry]';
const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i !== -1) { args.splice(i, 1); return true; } return false; };
const opt = (f) => { const i = args.indexOf(f); if (i === -1) return null; const v = args[i + 1] ?? ''; args.splice(i, 2); return v; };
const die = (code, msg) => { console.error(`wick-supersede: ${msg}`); process.exit(code); };

if (flag('--help') || flag('-h')) { console.log(usage); process.exit(0); }
const dry = flag('--dry');
const byId = opt('--by');
const dateArg = opt('--date');
const unknown = args.filter(a => /^--?[A-Za-z][\w-]*$/.test(a));
if (unknown.length) die(2, `unknown flag: ${unknown.join(' ')}\n${usage}`);
const [oldId, ...rest] = args;
const text = rest.join(' ').trim();
if (!oldId || (byId === null && !text) || (byId !== null && (!byId || text))) die(2, `give an old id and EITHER the new fact OR --by <new-id>\n${usage}`);

// Today in LOCAL time: the date a person would write down. (toISOString is UTC, which is tomorrow for a US evening.)
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const date = dateArg ?? today;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) die(2, `--date must be YYYY-MM-DD (got "${date}")`);
// A future date is a typo or a guess, never a fact (the freshness audit's rule): nothing has been superseded yet.
if (date > today) die(1, `--date ${date} is in the future. Supersede a fact on the day it stops holding, not before.`);
if (SUPERSEDED.test(text)) die(2, 'the new fact carries a [superseded:] tag of its own; it would be hidden the moment it was written.');

if (!fs.existsSync(MEM)) die(2, `cannot read ${MEM}: memory is UNREACHABLE. Nothing was written.`);

// ─── read ────────────────────────────────────────────────────────────────
const files = new Map();       // rel -> { p, lines (raw, '\r' kept), cr, before: the ids that existed }
function open(id) {
  const at = id.indexOf('#');
  if (at < 1) die(2, `"${id}" is not an entry id (<file>#<slug>). Ids come from wick-recall --index.`);
  const rel = id.slice(0, at).replace(/^\.\//, ''), p = path.resolve(MEM, rel), back = path.relative(MEM, p);
  // An id names a file INSIDE memory/. This tool writes, so a path that climbs out is refused, not followed.
  if (!rel.endsWith('.md') || back.startsWith('..') || path.isAbsolute(back)) die(2, `"${id}" does not name a memory/*.md file.`);
  if (rel === 'index.md') die(2, 'index.md is the map, not a fact. Supersede the entry in the file its row points at.');
  if (!files.has(rel)) {
    if (!fs.existsSync(p)) die(2, `no file ${rel} in ${MEM}.`);
    const src = fs.readFileSync(p, 'utf8');
    files.set(rel, { p, lines: src.split('\n'), cr: src.includes('\r\n') ? '\r' : '',
                     before: new Set(entries(rel, src).map(e => e.id)) });
  }
  const f = files.get(rel);
  const e = entries(rel, f.lines.join('\n')).find(x => x.id === `${rel}#${id.slice(at + 1)}`);
  if (!e) die(2, `no entry ${id}. Ids come from: node tools/wick-recall.mjs --index "<question>"`);
  return { rel, f, e };
}
const live = (rel) => entries(rel, files.get(rel).lines.join('\n'));
// A tag goes at the end of a line, before any '\r', so a CRLF file stays CRLF.
const tag = (f, i, t) => { const l = f.lines[i], cr = l.endsWith('\r') ? '\r' : ''; f.lines[i] = l.slice(0, l.length - cr.length) + t + cr; };
// The line that carries an entry's tags: a heading's own line, or a bullet's last line (it reads after the whole fact).
const tagLine = (e) => (e.kind === 'section' ? e.line - 1 : e.end);

const old = open(oldId);
if (old.e.superseded) {
  die(1, `${old.e.id} is already superseded (${old.e.superseded.date} → ${old.e.superseded.by || 'no pointer'}). ` +
         'Supersede its replacement instead; the chain is how history stays readable.');
}

// ─── write the new entry, or find the one named by --by ──────────────────────
let neu, inserted = [];
if (byId !== null) {
  neu = open(byId);
  if (neu.e.id === old.e.id) die(1, 'an entry cannot supersede itself.');
  if (neu.e.superseded) die(1, `${neu.e.id} is itself superseded; point at the current fact.`);
  tag(neu.f, tagLine(neu.e), ` [supersedes: ${old.e.id}]`);
} else {
  const { f, e } = old;
  if (e.kind === 'section' && !e.level) die(1, `${e.id} has no heading to mirror. Write the new fact yourself, then use --by <its id>.`);
  const [head, ...body] = text.split(/\r?\n/);
  const mark = ` [supersedes: ${e.id}]`;
  const plain = (s) => s.replace(/\r$/, '');
  let block, at;
  if (e.kind === 'item') {
    // Same shape as the old bullet: its marker, its date wrapper, then the new words. `- [D] x` stays `- [D] y`.
    const m = plain(f.lines[e.line - 1]).match(/^(\s*(?:[-*+]|\d+\.)\s+.*?)(\d{4}-\d{2}-\d{2})([\])*]*)/);
    const lines = [m[1] + date + m[3] + ' ' + head, ...body.map(l => '  ' + l)];
    lines[lines.length - 1] += mark;
    block = lines;
    at = e.end + 1;
  } else {
    // Same level, same date-and-separator shape: `### 2026-06-02 — Old` becomes `### <date> — New`. The pointer goes
    // on a body line that says in words what was replaced, and that line is not decoration: wick-ask drops a block that
    // is a bare heading, so a decision written as a title alone would be invisible to it while the old one is hidden.
    // It is a bullet if the old entry's body was bullets (decisions.md), a plain line if it was not (curiosity.md).
    const h = plain(f.lines[e.line - 1]);
    const m = h.match(/^(#{1,6}\s+.*?)(\d{4}-\d{2}-\d{2})([\])*]*)(\s+[—–:|·-]\s+)?/);
    const firstBody = e.lines.map(i => plain(f.lines[i])).find((l, j) => j > 0 && l.trim()) || '- ';
    block = [(m ? m[1] + date + m[3] + (m[4] || ' — ') : '#'.repeat(e.level) + ' ' + date + ' — ') + head,
             `${/^\s*(?:[-*+]|\d+\.)\s/.test(firstBody) ? '- ' : ''}**Replaces:** ${e.title}${mark}`, ...body];
    // Straight after the old section's last line of content. The parser's `end` already stops above a closing rule
    // and the italic footer under it, so the template's "*Wick appends to this file...*" stays the file's last line.
    at = e.end + 1;
    block = ['', ...block, ...(at < f.lines.length && plain(f.lines[at]).trim() ? [''] : [])];
  }
  f.lines.splice(at, 0, ...block.map(l => l + f.cr));
  inserted = block.map((_, j) => at + j);
  const made = live(old.rel).find(x => x.line - 1 === at + (e.kind === 'item' ? 0 : 1));
  if (!made) die(1, 'the new entry did not parse as an entry where it was written. Nothing was written.');
  neu = { rel: old.rel, f, e: made };
}
tag(old.f, tagLine(old.e), ` [superseded: ${date} → ${neu.e.id}]`);

// ─── verify before writing ───────────────────────────────────────────────
// Superseding must never break a pointer: every id that existed before must still name the SAME entry after. A new
// entry whose slug equals a later entry's would take that id and push the later one to "-2", so comparing the two id
// sets is not enough (both would still hold it). The ids after must be exactly the ids before, plus one new id that
// nobody held.
for (const [rel, f] of files) {
  const after = live(rel).map(e => e.id);
  const made = byId === null && rel === neu.rel ? [neu.e.id] : [];
  const want = [...f.before, ...made];
  const taken = made.filter(id => f.before.has(id));
  if (taken.length || after.length !== want.length || !want.every(id => after.includes(id))) {
    const moved = after.filter(id => !want.includes(id));
    die(1, `writing this would rename an existing entry (${[...taken, ...moved].join(', ') || 'ids changed'}), breaking any ` +
           'pointer to it. Reword the new fact and retry. Nothing was written.');
  }
}
const o2 = live(old.rel).find(e => e.id === old.e.id), n2 = live(neu.rel).find(e => e.id === neu.e.id);
if (!o2?.superseded || o2.superseded.by !== neu.e.id || !n2 || n2.superseded || n2.supersedes === null) {
  die(1, 'the tags did not read back as written. Nothing was written.');
}

// ─── stamp + index row: a content change moves Updated (§10) ─────────────────
const stamped = [];
const STAMP = /^(\*Updated:\s*)(\d{4}-\d{2}-\d{2})(.*\*\s*)$/;
const idxPath = path.join(MEM, 'index.md');
const idx = fs.existsSync(idxPath) ? fs.readFileSync(idxPath, 'utf8').split('\n') : null;
for (const [rel, f] of files) {
  const i = f.lines.slice(0, 12).findIndex(l => STAMP.test(l.replace(/\r$/, '')));    // under the H1, where §10 puts it
  if (i < 0) { stamped.push(`${rel}: no Updated stamp (wick-freshness-audit will say so)`); continue; }
  const [, pre, was, post] = f.lines[i].match(STAMP);
  if (was >= today) continue;
  f.lines[i] = pre + today + post;
  let row = '';
  // The index row moves with the stamp only if it agreed with it. A row that already disagreed is drift for
  // wick-freshness-audit to report, not something to paper over here.
  const r = idx ? idx.findIndex(l => {
    const m = l.match(/^\s*[-*]\s*\[[^\]]+\]\(([^)#]+)/);
    return m && m[1].replace(/^\.\//, '').trim() === rel && new RegExp(`\\(${was}\\)\\s*$`).test(l);
  }) : -1;
  if (r >= 0) { idx[r] = idx[r].replace(new RegExp(`\\(${was}\\)(\\s*)$`), `(${today})$1`); row = '; index.md row too'; }
  stamped.push(`${rel}: Updated ${was} -> ${today}${row}`);
}

// ─── report, then write ──────────────────────────────────────────────────
console.log(`wick-supersede${dry ? ' --dry (nothing written)' : ''}`);
console.log(`  superseded  ${old.e.id}  (${old.rel}:${old.e.line})  on ${date}`);
console.log(`  by          ${neu.e.id}  (${neu.rel}:${neu.e.line}${byId === null ? ', new' : ''})`);
for (const s of stamped) console.log(`  stamp       ${s}`);
if (inserted.length) {
  console.log('\n  new entry:');
  for (const i of inserted) { const l = old.f.lines[i].replace(/\r$/, ''); console.log(l ? `    ${l}` : ''); }
}
if (dry) process.exit(0);
for (const [, f] of files) fs.writeFileSync(f.p, f.lines.join('\n'));
if (idx && stamped.some(s => s.endsWith('index.md row too'))) fs.writeFileSync(idxPath, idx.join('\n'));
console.log('\n  Nothing was deleted. wick-recall and wick-ask now leave the old entry out; --include-superseded reads it.');
