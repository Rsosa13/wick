#!/usr/bin/env node
// ─── wick-recall — zero-token memory routing ────────────────────────────────
// Point a question at the memory layer and get back the 1-2 files that answer it,
// for ZERO model tokens and ~1ms. BM25 over a compiled retrieval surface (each file's
// index row + its headers + bold lead-ins + technical terms).
//
// WHY: MEMORY-PROTOCOL.md makes memory *findable by discipline* (one topic per file,
// one writer per fact-class). This makes it findable *for free*. Reading the whole
// memory layer to answer one question is the context bulge; routing is the fix.
//
// WHEN IT PAYS (measured 2026-07-31, see MEMORY-PROTOCOL.md §9):
//   - index-first beats load-everything from ~3 files onward (an index row is ~38 tok,
//     a mean memory file ~1,600)
//   - the ABSOLUTE saving only becomes material as memory grows:
//     11 files ≈ 4.7k -> 1.3k tok  ·  24 files ≈ 38.6k -> 3.2k tok
//   - routing recall DEGRADES with corpus size (100% @5 files, 94% @11, 83% @24) —
//     so as memory grows, the index rows must get sharper, not just longer.
//
// STEPWISE (2026-10-20, MEMORY-PROTOCOL.md §14). Naming the right FILE stops being enough once the file is long: facts
// a 7B reader recovered 100% of the time from a 150-line slice, it recovered 17% of the time inside the 551-line file
// they came from (§13). So the router also answers in two steps, the way claude-mem retrieves:
//   1. --index "<question>"   one line per ENTRY (id, score, what it says) from the routed files, never more than -n
//                             lines however large memory grows: small enough to load every time
//   2. --get <id> [<id> ...]  the full text of the entries you chose, and nothing else
// An ENTRY is a heading's section, or a top-level bullet that starts with its date (§10 already asks every log entry to
// carry one). Its id is <file>#<its title, slugged>. The entry ranking is new and UNMEASURED: §9's recall figures
// describe the file router, which step 1 runs first and which is unchanged.
//
// SUPERSEDED, NOT DELETED (§14). An entry tagged [superseded: <date> → <id>] was true and was replaced. Every mode
// leaves it out by default (the routing surface, --index, --get, and wick-ask's sources), and --get on its id follows
// the pointer to the replacement. --include-superseded brings the history back. A file with no tag is read byte for
// byte as before. tools/wick-supersede.mjs writes the tags.
//
// Zero dependencies. Node >= 18.
//   node tools/wick-recall.mjs "how do I handle a flaky prediction?"
//   node tools/wick-recall.mjs -k 3 "what did we decide about pricing?"
//   node tools/wick-recall.mjs --index "what did we decide about pricing?"     step 1 (-n N rows, default 8)
//   node tools/wick-recall.mjs --get decisions.md#2026-10-20-annual-pricing    step 2
//   node tools/wick-recall.mjs --include-superseded --index "pricing"         superseded entries too, marked

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// WICK_MEMORY points the router at another memory layer (a second agent's, or a frozen snapshot you are measuring
// against). Default: the memory/ directory next to tools/, as always.
const MEM = path.resolve(process.env.WICK_MEMORY || path.join(HERE, '..', 'memory'));

const STOP = new Set(('the a an and or of to in for on is are was were be with as at by from this ' +
  'that it its not but we you our your they their has have had will would can could should how do ' +
  'i what when where which who why my me').split(' '));

export const tok = (s) => (s || '').toLowerCase().match(/[a-z0-9][a-z0-9\-_]+/g)?.filter(w => !STOP.has(w) && w.length > 2) ?? [];

function entities(txt) {
  const out = [];
  for (const re of [/`([^`\n]{2,40})`/g, /\b([A-Z]{2,}(?:[-_][A-Z0-9]+)*)\b/g,
                    /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g, /\b(\w+\.(?:mjs|js|md|json|sh|py))\b/g,
                    /\b([a-z]+(?:-[a-z]+){1,3})\b/g]) {
    for (const m of txt.matchAll(re)) out.push(m[1]);
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function reachable() {
  // DO NOT return [] when this fails. An empty corpus and an unreadable one are different facts, and the caller
  // cannot tell them apart once both become "(no match)". That is the same defect that shows up in retrieval-grounded
  // models: asserting an absence you have not established. Grounded honesty has to apply to our own I/O or it is a
  // slogan.
  if (!fs.existsSync(MEM)) {
    console.error(`wick-recall: cannot read ${MEM} — memory is UNREACHABLE, not empty.`);
    console.error('  Refusing to report "(no match)": that would claim the memory contains nothing');
    console.error('  when what is true is that it could not be opened. Check the path and re-run.');
    process.exit(2);
  }
}

// ─── entries: the unit of stepwise retrieval, and of validity ───────────────
const HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const ITEM = /^(?:[-*+]|\d+\.)\s/;
// A top-level bullet is an entry of its own when it STARTS with its date: `- [2026-10-20] ...`, `- 2026-10-20 ...`,
// `- **2026-10-20** ...`, or domain-knowledge's `- **Term** *[2026-10-20]* — ...`. A dated FIELD inside a record
// (`- **Review date:** 2026-12-01` under a decision's heading) is not: splitting it off would cut the decision in two,
// and two halves of one topic route worse than the whole (§13).
const DATED = /^(?:[-*+]|\d+\.)\s+(?:\[|\(|\*\*)?(\d{4}-\d{2}-\d{2})|^(?:[-*+]|\d+\.)\s+\*\*[^*]+\*\*\s*\*\[(\d{4}-\d{2}-\d{2})\]\*/;
const META = /^(?:\*Updated:.*\*|-{3,}|\*{3,}|_{3,})$/;          // a stamp or a rule: structure, not content
// The validity tags (§14). Read only outside code spans, fences and comments, so a note that DOCUMENTS the syntax is
// not read AS the syntax (wick-decay-audit found that one first, on the document that defines its own tag).
export const SUPERSEDED = /\[superseded:\s*(\d{4}-\d{2}-\d{2})\s*(?:→|->|—|by\b)?\s*([^\]\s]*)[^\]]*\]/i;
export const SUPERSEDES = /\[supersedes:\s*([^\]\s]+)[^\]]*\]/i;
const TAGS = /\s*\[(?:superseded|supersedes):[^\]]*\]/gi;

const clean = (s) => s.replace(TAGS, '').replace(/<!--.*?-->/g, '').replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
  .replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();

// The id is the title, slugged: the date and the first words, which is what a person would grep for. Tags are
// stripped first, so marking an entry superseded never changes its id and never breaks a pointer to it.
export function slug(title) {
  const words = title.replace(TAGS, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  let s = '';
  for (const w of words.slice(0, 10)) {
    if (s && s.length + 1 + w.length > 64) break;
    s = s ? `${s}-${w}` : w;
  }
  return s || 'entry';
}

function parse(rel, text) {
  const raw = text.split('\n');
  const lines = raw.map(l => l.replace(/\r$/, ''));
  // Inert lines sit inside a fenced block or an HTML comment. The shipped templates keep their example entries in
  // comments, and an example is not an entry.
  const inert = [];
  let fence = false, comment = false;
  for (const l of lines) {
    const t = l.trim();
    if (!comment && /^(```|~~~)/.test(t)) { inert.push(true); fence = !fence; continue; }
    if (!fence && !comment && t.startsWith('<!--')) comment = true;
    inert.push(fence || comment);
    if (comment && t.includes('-->')) comment = false;
  }
  // What an entry SAYS: no comment, no fence, no stamp (its "first written" would match every question with "first"
  // in it), and no code span.
  const live = (own) => own.filter(i => !inert[i] && !META.test(lines[i].trim())).map(i => lines[i]).join('\n')
    .replace(/`[^`\n]*`/g, ' ');

  // One pass gives every line an owner: the open dated bullet if the line continues it, else the open section.
  let sec = { kind: 'section', level: 0, title: rel.split('/').pop().replace(/\.md$/, ''), start: 0, own: [] };
  let item = null, gap = [];
  const secs = [sec], items = [];
  const close = () => { if (item) items.push(item); item = null; sec.own.push(...gap); gap = []; };
  lines.forEach((l, i) => {
    if (item) {
      if (!l.trim()) { gap.push(i); return; }
      // an indented line continues the bullet; so does an unindented one straight after it (a lazy wrap)
      if (/^\s/.test(l) || (!gap.length && !inert[i] && !HEADING.test(l) && !ITEM.test(l) && !META.test(l.trim()))) {
        item.own.push(...gap, i); gap = []; return;
      }
      close();
    }
    const h = !inert[i] && l.match(HEADING);
    if (h) { sec = { kind: 'section', level: h[1].length, title: h[2], start: i, own: [i] }; secs.push(sec); return; }
    const d = !inert[i] && l.match(DATED);
    if (d) {
      item = { kind: 'item', level: 0, title: l.replace(/^(?:[-*+]|\d+\.)\s+/, ''), date: d[1] || d[2], start: i, own: [i], sec };
      return;
    }
    sec.own.push(i);
  });
  close();

  // A section runs to the next heading at its own level or above, so a tag on a heading retires everything under it.
  // It ENDS at its last line of content: trailing blanks are not content, and neither is a closing rule with only an
  // italic footer under it (the templates end "---" then "*Wick appends to this file...*"). That footer belongs to
  // the file, not to whichever entry happens to be last, and it is where wick-supersede stops when it appends.
  secs.forEach((s, j) => {
    const next = secs.slice(j + 1).find(t => s.level === 0 || t.level <= s.level);
    let end = next ? next.start - 1 : lines.length - 1;
    for (let i = end; i > s.start; i--) {
      const t = lines[i].trim();
      if (!inert[i] && /^(?:-{3,}|\*{3,}|_{3,})$/.test(t)) { end = i - 1; break; }
      if (t && !inert[i] && !/^[*_][^*_].*[*_]$/.test(t)) break;
    }
    while (end > s.start && !lines[end].trim()) end--;
    s.end = end;
    s.own = s.own.filter(i => i <= end);
  });
  const all = [...secs, ...items].sort((a, b) => a.start - b.start);
  for (const e of all) {
    const txt = live(e.own), m = txt.match(SUPERSEDED), s = txt.match(SUPERSEDES);
    e.superseded = m ? { date: m[1], by: m[2] } : null;
    e.supersedes = s ? s[1] : null;
    if (e.kind === 'item') e.end = Math.max(...e.own);
  }
  const hide = new Set();
  for (const s of secs) if (s.superseded) for (let i = s.start; i <= s.end; i++) hide.add(i);
  for (const e of all) {
    if (!e.superseded) {
      const up = secs.find(s => s.superseded && s !== e && s.start < e.start && e.start <= s.end);
      if (up) e.superseded = { ...up.superseded, inherited: true };
    }
    if (e.superseded && e.kind === 'item') e.own.forEach(i => hide.add(i));
  }

  const used = new Set(), list = [];
  for (const e of all) {
    let first = null;
    if (e.kind === 'section') {
      // A heading with nothing of its own under it (only dated bullets, or only a template comment) is a container,
      // not an entry: listing it would spend an index row on a word. A DATED heading is an entry even when bare: a
      // decision can be all title.
      const body = e.own.filter(i => !(e.level && i === e.start) && !inert[i] && lines[i].trim() && !META.test(lines[i].trim()));
      if (!body.length && !/\d{4}-\d{2}-\d{2}/.test(e.title)) continue;
      first = body.length ? clean(lines[body[0]]) : null;
    }
    const base = slug(e.title);
    let sl = base, n = 1;
    while (used.has(sl)) sl = `${base}-${++n}`;
    used.add(sl);
    const title = clean(e.title);
    list.push({
      id: `${rel}#${sl}`, path: rel, kind: e.kind, level: e.level, line: e.start + 1, end: e.end, lines: e.own,
      title, date: e.date || (title.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || null,
      section: e.kind === 'item' ? clean(e.sec.title) : '',
      desc: first && first !== title ? `${title} — ${first}` : title,
      text: e.own.map(i => lines[i]).join('\n'), live: live(e.own),
      superseded: e.superseded, supersedes: e.supersedes,
    });
  }
  return { list, hide, raw };
}

export function entries(rel, text) { return parse(rel, text).list; }

export function activeText(rel, text, { includeSuperseded = false } = {}) {
  // The cheap test first: memory with no tag in it is returned AS IS, so every unmarked layer reads exactly as before.
  if (includeSuperseded || !/\[superseded:/i.test(text)) return text;
  const { hide, raw } = parse(rel, text);
  if (!hide.size) return text;
  // A hidden line becomes an empty line, not a missing one: line numbers still match the file, and the entries on
  // either side of a hidden one stay separate paragraphs (wick-ask cuts its chunks at blank lines).
  return raw.map((l, i) => (hide.has(i) ? '' : l)).join('\n');
}

export function load({ includeSuperseded = false } = {}) {
  reachable();
  const body = {};
  for (const p of walk(MEM)) body[path.relative(MEM, p).replace(/\\/g, '/')] = fs.readFileSync(p, 'utf8');

  // curated one-liners from memory/index.md — the highest-signal routing surface
  const desc = {};
  const idx = body['index.md'] || '';
  for (const m of idx.matchAll(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*[—\-:]*\s*(.*)$/gm)) {
    let p = m[2].split('#')[0].replace('./', '').trim();
    if (!body[p]) p = Object.keys(body).find(k => k.endsWith(p.split('/').pop())) || p;
    if (body[p]) desc[p] = [m[1], m[3]];
  }

  const docs = [];
  for (const [rel, raw] of Object.entries(body)) {
    if (rel === 'index.md') continue;
    // A superseded entry leaves the routing surface (§14). A file with no tag comes back from activeText unchanged.
    const txt = activeText(rel, raw, { includeSuperseded });
    const [label, d] = desc[rel] || ['', ''];
    // NO CAP on headers or bold lead-ins (2026-09-29). This used to keep the first 25 of each. Memory files grow
    // DOWNWARD, so the 25 that survived were the OLDEST entries and every recent finding was unroutable: a real
    // 57-file layer had files carrying 227 and 339 bold lead-ins, of which the router saw 25. Removing the cap moved
    // recall@2 from 79% to 88% on a labelled query set and from 75% to 83% on recent-content queries, with no
    // regression; caps of 50 or 100 change nothing, because the big files are far past both. (Measured on a real 57-file
    // memory layer, 2026-08-19; the same defect, the same fix.)
    const heads = (txt.match(/^#{1,4}\s*(.+)$/gm) || []).join(' ');
    const bolds = [...txt.matchAll(/\*\*(.+?)\*\*/g)].map(m => m[1]).join(' ');
    const surface = [label, d, label, d, label, d,
                     rel.replace(/[/\-]/g, ' ').replace('.md', ''),
                     rel.replace(/[/\-]/g, ' ').replace('.md', ''),
                     heads, bolds, entities(txt).join(' ')].join(' ');
    docs.push({ path: rel, bytes: raw.length, desc: d, terms: tok(surface) });
  }
  return docs;
}

export function rank(query, docs, k = 2, k1 = 1.5, b = 0.75) {
  const N = docs.length, df = new Map();
  for (const d of docs) {
    d.tf = new Map();
    for (const t of d.terms) d.tf.set(t, (d.tf.get(t) || 0) + 1);
    d.len = d.terms.length;
    for (const t of new Set(d.terms)) df.set(t, (df.get(t) || 0) + 1);
  }
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, N);
  const idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + (N - n + 0.5) / (n + 0.5))]));
  const q = tok(query);
  return docs.map(d => {
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (f) s += (idf.get(t) || 0) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avg));
    }
    return { s, d };
  }).sort((a, b2) => b2.s - a.s).slice(0, k).filter(x => x.s > 0);
}

// Step 1. Route to files with the measured router, then rank the ENTRIES inside them and keep the top n. The output
// is bounded by n, not by the size of memory: that bound is what makes it safe to load on every question.
export function index(query, { k = 2, n = 8, includeSuperseded = false } = {}) {
  const docs = load({ includeSuperseded });
  const files = rank(query, docs, k).map(h => h.d.path);
  const pool = [];
  files.forEach((f, r) => {
    for (const e of entries(f, fs.readFileSync(path.join(MEM, f), 'utf8'))) {
      if (!e.superseded || includeSuperseded) pool.push({ ...e, rank: r });
    }
  });
  // Newest first within a tie: memory is appended at the bottom (§13), so a later line is a later entry.
  pool.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.rank - b.rank || b.line - a.line);
  const cands = pool.map(e => ({ e, terms: tok([e.title, e.section, e.live].join(' ')) }));
  let hits = rank(query, cands, cands.length);
  // No entry shares a word with the question (the file was routed on its index row): show its newest entries instead.
  if (!hits.length) hits = cands.map(d => ({ s: 0, d }));
  return { scanned: docs.length, files, hits: hits.slice(0, n).map(h => ({ s: h.s, ...h.d.e })) };
}

// Step 2. The full text of each id asked for. A superseded id resolves to whatever replaced it (following the chain),
// unless the history was asked for; `via` records every superseded entry it stepped over.
export function get(ids, { includeSuperseded = false } = {}) {
  reachable();
  const cache = new Map();
  const find = (id) => {
    const at = id.indexOf('#');
    if (at < 1) return null;
    const file = id.slice(0, at).replace(/^\.\//, ''), p = path.resolve(MEM, file), back = path.relative(MEM, p);
    if (!file.endsWith('.md') || back.startsWith('..') || path.isAbsolute(back) || !fs.existsSync(p)) return null;
    if (!cache.has(file)) cache.set(file, entries(file, fs.readFileSync(p, 'utf8')));
    return cache.get(file).find(e => e.id === `${file}#${id.slice(at + 1)}`) || null;
  };
  return ids.map(asked => {
    let e = find(asked);
    const via = [];
    while (e && e.superseded && !includeSuperseded && via.length < 10 && !via.includes(e)) {
      via.push(e);
      const by = e.superseded.by;
      e = by ? find(by.startsWith('#') ? e.path + by : by) : null;
    }
    if (e && e.superseded && !includeSuperseded) e = null;      // a loop, or a chain longer than 10
    return { asked, entry: e, via };
  });
}

export { MEM };

const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function main() {
  const args = process.argv.slice(2);
  const flag = (f) => { const i = args.indexOf(f); if (i !== -1) { args.splice(i, 1); return true; } return false; };
  const num = (f, d) => { const i = args.indexOf(f); if (i === -1) return d; const v = parseInt(args[i + 1], 10); args.splice(i, 2); return v; };
  const k = num('-k', 2), n = num('-n', 8);
  const includeSuperseded = flag('--include-superseded'), step1 = flag('--index'), step2 = flag('--get');
  const usage = 'usage: node tools/wick-recall.mjs [-k N] "<what you are looking for>"\n' +
                '       node tools/wick-recall.mjs --index [-n N] "<question>"   step 1: one line per entry, at most N\n' +
                '       node tools/wick-recall.mjs --get <id> [<id> ...]         step 2: those entries in full\n' +
                '       --include-superseded   also read entries tagged [superseded: ...] (MEMORY-PROTOCOL.md §14)';
  if (flag('--help') || flag('-h')) { console.log(usage); process.exit(0); }
  // An unknown flag is an error, not a word of the query: a mistyped --include-superseded would otherwise be searched
  // for as text, and the answer would quietly leave out the history it was asked to include.
  const unknown = args.filter(a => /^--?[A-Za-z][\w-]*$/.test(a));
  if (unknown.length) { console.error(`unknown flag: ${unknown.join(' ')}\n${usage}`); process.exit(2); }

  if (step2) {
    const ids = args.flatMap(a => a.split(/\s+/)).filter(Boolean);
    if (!ids.length) { console.log(usage); process.exit(1); }
    let missing = 0;
    for (const { asked, entry, via } of get(ids, { includeSuperseded })) {
      for (const v of via) {
        console.log(`(${v.id} was superseded on ${v.superseded.date} by ${v.superseded.by || '(no pointer)'}; ` +
                    '--include-superseded reads it)');
      }
      if (!entry) {
        missing++;
        console.error(`wick-recall: no ${via.length ? 'active replacement for' : 'entry'} ${asked}`);
        continue;
      }
      const mark = entry.superseded ? `  [SUPERSEDED ${entry.superseded.date} → ${entry.superseded.by}]` : '';
      console.log(`── ${entry.id}  (${entry.path}:${entry.line})${mark}\n${entry.text}\n`);
    }
    // Every id asked for must be answered. Printing the ones found and exiting 0 would report a read we did not do.
    process.exit(missing ? 2 : 0);
  }

  const query = args.join(' ');
  if (!query) {
    console.log(usage);
    process.exit(1);
  }

  if (step1) {
    const { scanned, files, hits } = index(query, { k, n, includeSuperseded });
    if (!scanned) { console.log('(no memory/*.md files found)'); process.exit(0); }
    if (!files.length) { console.log('(no match — read memory/index.md directly)'); process.exit(0); }
    console.log(`files: ${files.join(', ')}`);
    if (!hits.length) console.log('  (no active entries in these files — --include-superseded shows the history)');
    const w = Math.min(56, Math.max(0, ...hits.map(h => h.id.length)));
    for (const h of hits) {
      const mark = h.superseded ? `  [superseded ${h.superseded.date} → ${h.superseded.by}]` : '';
      console.log(`  ${h.id.padEnd(w)} ${h.s.toFixed(2).padStart(6)}  ${short(h.desc, 80)}${mark}`);
    }
    console.log('then: node tools/wick-recall.mjs --get <id> [<id> ...]');
    return;
  }

  const docs = load({ includeSuperseded });
  if (!docs.length) { console.log('(no memory/*.md files found)'); process.exit(0); }
  const hits = rank(query, docs, k);
  if (!hits.length) { console.log('(no match — read memory/index.md directly)'); process.exit(0); }
  for (const { s, d } of hits) {
    console.log(`  ${d.path.padEnd(38)} ${(d.bytes / 1024).toFixed(1).padStart(5)} KB  score ${s.toFixed(2).padStart(6)}  ${d.desc.slice(0, 60)}`);
  }
}

// Run as a CLI only when invoked directly; `import { load, rank }` (wick-ask does) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
