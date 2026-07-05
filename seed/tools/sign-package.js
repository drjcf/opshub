#!/usr/bin/env node
// Sign a course JSON into an .opscourse.json package.
// Usage: node sign-package.js <course.json> <catalogId> <catalogVersion> <privateKey.pem> [slots.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, sign } from 'node:crypto';

function canonical(obj) {
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  if (obj && typeof obj === 'object') {
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(obj);
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const [, , coursePath, catalogId, catalogVersionStr, keyPath, slotsPath] = process.argv;
if (!keyPath) {
  console.error('Usage: node sign-package.js <course.json> <catalogId> <catalogVersion> <privateKey.pem> [slots.json]');
  process.exit(1);
}
const course = JSON.parse(readFileSync(coursePath, 'utf8'));
const catalogVersion = Number(catalogVersionStr);
const slots = slotsPath ? JSON.parse(readFileSync(slotsPath, 'utf8')) : [];
const contentHash = sha256(canonical(course));
const key = createPrivateKey(readFileSync(keyPath, 'utf8'));
const signature = sign(null, Buffer.from(`${contentHash}|${catalogId}|${catalogVersion}`), key).toString('base64');

const pkg = {
  format: 'opscourse/1', catalogId, catalogVersion, minAppVersion: '0.2.0',
  course, siteSpecificSlots: slots, contentHash,
  publisher: 'EdAI Systems', signature,
};
const out = `${catalogId}.v${catalogVersion}.opscourse.json`;
writeFileSync(out, JSON.stringify(pkg, null, 2));
console.log(`Wrote ${out}\ncontentHash: ${contentHash}`);
