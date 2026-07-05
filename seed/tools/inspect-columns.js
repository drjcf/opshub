#!/usr/bin/env node
// inspect-columns.js — reveal the COLUMN GEOMETRY of a standards page.
// Prints the distinct x-positions (columns) and, for each text item, which
// column it's in + first few chars (truncated, no copyright exposure).
// Run: node inspect-columns.js <pdf> <pageNumber>
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const file = process.argv[2];
const pageNum = parseInt(process.argv[3] || '52', 10);
const data = new Uint8Array(await readFile(file));
const pdf = await getDocument({ data }).promise;
const page = await pdf.getPage(pageNum);
const content = await page.getTextContent();

// Histogram of x-positions (rounded to nearest 5) → reveals columns.
const xHist = {};
for (const it of content.items) {
  if (!it.str.trim()) continue;
  const x = Math.round(it.transform[4] / 5) * 5;
  xHist[x] = (xHist[x] || 0) + 1;
}
console.log(`# Page ${pageNum} — x-position histogram (column boundaries)`);
for (const [x, n] of Object.entries(xHist).sort((a,b)=>Number(a[0])-Number(b[0])))
  console.log(`  x=${String(x).padStart(4)}  ${'█'.repeat(Math.min(n,40))} ${n}`);

// Row-by-row: group items by y, show each item's x + 8-char sample.
console.log(`\n# First 20 rows: [x=NNN|"sample"] per item, left-to-right`);
const rows = {};
for (const it of content.items) {
  if (!it.str.trim()) continue;
  const y = Math.round(it.transform[5]);
  (rows[y] ||= []).push({ x: Math.round(it.transform[4]), s: it.str });
}
Object.keys(rows).sort((a,b)=>b-a).slice(0,20).forEach(y=>{
  const cells = rows[y].sort((a,b)=>a.x-b.x)
    .map(c => `[x=${c.x}|"${c.s.replace(/\s+/g,' ').trim().slice(0,8)}"]`).join(' ');
  console.log('  '+cells);
});
console.log('\nDone. x-positions + 8-char samples only — safe to share.');
