#!/usr/bin/env node
// inspect-handbook.js v2 — scans a PAGE RANGE (standards live mid-document,
// not in the front-matter) and casts a wider net for citation-code formats.
// Emits structure + codes only; prose truncated. Safe to share the output.
//
//   node inspect-handbook.js <pdf> [startPage] [endPage]
//   e.g. node inspect-handbook.js handbook.pdf 40 60

import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const file = process.argv[2];
const start = parseInt(process.argv[3] || '40', 10);
const end = parseInt(process.argv[4] || '60', 10);
if (!file) { console.error('Usage: node inspect-handbook.js <pdf> [startPage] [endPage]'); process.exit(1); }

// Wider net — many possible code formats. We report whichever fires.
const PATTERNS = {
  'dotted-roman':    /\b\d{1,2}\.[IVXLC]+\.[A-Z]\b/g,        // 10.I.C
  'dotted-numeric':  /\b\d{1,2}\.\d{1,2}(?:\.\d{1,2})?\b/g,  // 10.1 or 10.1.3
  'roman-alone':     /^\s*[IVXLC]{1,4}\.\s/gm,               // I.  II.  (chapter?)
  'letter-paren':    /^\s*\(?[A-Z]\)?[.)]\s/gm,              // A.  (A)
  'subelement-low':  /^\s*\(?[a-z]\)?[.)]\s/gm,              // (a) a.
  'subelement-num':  /^\s*\(?\d{1,2}\)?[.)]\s/gm,            // 1. (1)
  'chapter-word':    /\bChapter\s+\d{1,2}\b/gi,
  'adjunct-kw':      /\b(Adjunct|Related Standard|Cross-?reference)\b/gi,
  'hash-code':       /\b\d{1,2}\.[A-Z]\b/g,                  // 10.A
};

const truncate = (s, n = 10) => { const t = (s||'').replace(/\s+/g,' ').trim(); return t.length<=n?t:t.slice(0,n)+'…'; };

const data = new Uint8Array(await readFile(file));
const pdf = await getDocument({ data }).promise;
const s = Math.max(1, start), e = Math.min(pdf.numPages, end);

console.log(`# Handbook inspection — pages ${s}–${e} of ${pdf.numPages}\n`);

const hits = Object.fromEntries(Object.keys(PATTERNS).map(k => [k, 0]));
const codeSamples = new Set();
const leadTokens = {}; // distinct short line-leading tokens (reveals code shape)

for (let p = s; p <= e; p++) {
  const page = await pdf.getPage(p);
  const content = await page.getTextContent();
  const rows = {};
  for (const it of content.items) {
    const y = Math.round(it.transform[5]);
    (rows[y] ||= []).push({ x: it.transform[4], s: it.str, size: it.transform[0] });
  }
  const lines = Object.keys(rows).sort((a,b)=>b-a).map(y => ({
    text: rows[y].sort((a,b)=>a.x-b.x).map(i=>i.s).join(''),
    x: Math.round(Math.min(...rows[y].map(i=>i.x))),
    size: Math.round(Math.max(...rows[y].map(i=>i.size||0))),
  }));

  for (const ln of lines) {
    for (const [name, re] of Object.entries(PATTERNS)) {
      const m = ln.text.match(re);
      if (m) {
        hits[name] += m.length;
        if (['dotted-roman','dotted-numeric','hash-code','roman-alone'].includes(name))
          m.slice(0,2).forEach(c => codeSamples.add(c.trim()));
      }
    }
    // capture the first 1-8 chars of lines that look like they START with a label
    const lead = ln.text.match(/^\s*([A-Z0-9IVXLC][\w.)(-]{0,7})/);
    if (lead && /[0-9.]/.test(lead[1])) {
      const key = lead[1];
      leadTokens[key] = (leadTokens[key]||0)+1;
    }
  }
}

console.log('## Pattern match counts');
for (const [k,v] of Object.entries(hits)) if (v) console.log(`  ${k.padEnd(16)} ${v}`);
if (!Object.values(hits).some(v=>v)) console.log('  (no patterns matched — paste the sample lines below so we can see the real format)');

console.log('\n## Sample codes captured');
console.log('  ' + ([...codeSamples].slice(0,25).join('  ') || '(none)'));

console.log('\n## Most common line-leading tokens with digits (likely codes/numbering)');
for (const [k,v] of Object.entries(leadTokens).sort((a,b)=>b[1]-a[1]).slice(0,20))
  console.log(`  "${k}"  ×${v}`);

console.log('\n## Sample: first 14 lines of the middle page (indent + fontsize + 10-char prose)');
const mid = await pdf.getPage(Math.floor((s+e)/2));
const mc = await mid.getTextContent();
const mrows = {};
for (const it of mc.items) { const y=Math.round(it.transform[5]); (mrows[y]||=[]).push({x:it.transform[4],s:it.str,size:it.transform[0]}); }
Object.keys(mrows).sort((a,b)=>b-a).slice(0,14).forEach(y=>{
  const items = mrows[y].sort((a,b)=>a.x-b.x);
  const text = items.map(i=>i.s).join('');
  const indent = Math.round(Math.min(...items.map(i=>i.x)));
  const size = Math.round(Math.max(...items.map(i=>i.size||0)));
  console.log(`  x=${String(indent).padStart(3)} sz=${String(size).padStart(2)}  "${truncate(text,10)}"`);
});

console.log('\nDone. Structure + codes only — safe to share.');
