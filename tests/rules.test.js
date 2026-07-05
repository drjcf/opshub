// tests/rules.test.js — Session A gate: security-rules behavior verification.
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteDoc, Timestamp } from 'firebase/firestore';

const ORG = 'ferguson';
const OTHER_ORG = 'someoneelse';
let passed = 0, failed = 0;
const results = [];

async function check(name, fn) {
  try { await fn(); passed++; results.push(`  PASS  ${name}`); }
  catch (e) { failed++; results.push(`  FAIL  ${name} :: ${e.message?.slice(0, 120)}`); }
}

const env = await initializeTestEnvironment({
  projectId: 'opshub-rules-test',
  firestore: {
    rules: readFileSync('firestore.rules', 'utf8'),
    host: '127.0.0.1',
    port: 8080,
  },
});

const staff = env.authenticatedContext('staff1', {
  orgId: ORG, roles: ['staff'], name: 'Staff One',
}).firestore();
const admin = env.authenticatedContext('admin1', {
  orgId: ORG, roles: ['owner', 'admin'], name: 'Admin One',
}).firestore();
const outsider = env.authenticatedContext('out1', {
  orgId: OTHER_ORG, roles: ['owner', 'admin'],
}).firestore();
const surveyorLive = env.authenticatedContext('svy1', {
  orgId: ORG, roles: ['surveyor'], surveyorUntil: Date.now() + 3600_000,
}).firestore();
const surveyorExpired = env.authenticatedContext('svy2', {
  orgId: ORG, roles: ['surveyor'], surveyorUntil: Date.now() - 3600_000,
}).firestore();

await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, `orgs/${ORG}`), { name: 'Ferguson', status: 'active' });
  await setDoc(doc(db, `orgs/${ORG}/evidence/evFinal`), {
    type: 'log', title: 'Fridge temp', status: 'finalized',
    createdBy: { uid: 'staff1' }, finalizedBy: { uid: 'staff1' },
  });
  await setDoc(doc(db, `orgs/${ORG}/evidence/evDraft`), {
    type: 'minutes', title: 'GB minutes draft', status: 'draft',
    createdBy: { uid: 'staff1' },
  });
  await setDoc(doc(db, `orgs/${ORG}/registers/reg1`), { title: 'Crash cart', version: 3, items: [] });
  await setDoc(doc(db, `orgs/${ORG}/tasks/t1`), { title: 'Check', status: 'open' });
  await setDoc(doc(db, `orgs/${ORG}/checkpoints/cp1`), { label: 'Fridge', qrToken: 'tok', active: true });
  await setDoc(doc(db, `orgs/${ORG}/members/staff1`), { email: 's@x.com', active: true, roles: ['staff'] });
  await setDoc(doc(db, `orgs/${ORG}/courses/c1`), { title: 'BBP', status: 'published' });
  await setDoc(doc(db, `orgs/${ORG}/courses/c1/answerKeys/l1`), { q1: { correctIndex: 2 } });
  await setDoc(doc(db, `orgs/${ORG}/auditLog/a1`), { action: 'x', at: Timestamp.now() });
});

await check('staff creates draft evidence attributed to self', () =>
  assertSucceeds(setDoc(doc(staff, `orgs/${ORG}/evidence/evNew`), {
    type: 'log', title: 'x', status: 'draft', createdBy: { uid: 'staff1' },
  })));
await check('staff CANNOT create evidence attributed to someone else', () =>
  assertFails(setDoc(doc(staff, `orgs/${ORG}/evidence/evSpoof`), {
    type: 'log', title: 'x', status: 'draft', createdBy: { uid: 'admin1' },
  })));
await check('staff CANNOT create evidence born finalized', () =>
  assertFails(setDoc(doc(staff, `orgs/${ORG}/evidence/evBorn`), {
    type: 'log', title: 'x', status: 'finalized', createdBy: { uid: 'staff1' },
  })));
await check('creator edits own draft (non-protected field)', () =>
  assertSucceeds(updateDoc(doc(staff, `orgs/${ORG}/evidence/evDraft`), { title: 'edited' })));
await check('client CANNOT self-finalize a draft', () =>
  assertFails(updateDoc(doc(staff, `orgs/${ORG}/evidence/evDraft`), { status: 'finalized' })));
await check('finalized evidence is immutable even to admin', () =>
  assertFails(updateDoc(doc(admin, `orgs/${ORG}/evidence/evFinal`), { title: 'tamper' })));
await check('evidence cannot be deleted, even by admin', () =>
  assertFails(deleteDoc(doc(admin, `orgs/${ORG}/evidence/evFinal`))));

await check('tasks are not client-writable', () =>
  assertFails(updateDoc(doc(admin, `orgs/${ORG}/tasks/t1`), { status: 'complete' })));
await check('registers are not client-writable', () =>
  assertFails(updateDoc(doc(admin, `orgs/${ORG}/registers/reg1`), { version: 99 })));
await check('auditLog is not client-writable', () =>
  assertFails(setDoc(doc(admin, `orgs/${ORG}/auditLog/a2`), { action: 'forge' })));
await check('answerKeys unreadable even to admin', () =>
  assertFails(getDoc(doc(admin, `orgs/${ORG}/courses/c1/answerKeys/l1`))));

await check('staff reads register', () =>
  assertSucceeds(getDoc(doc(staff, `orgs/${ORG}/registers/reg1`))));
await check('staff CANNOT create checklist template', () =>
  assertFails(setDoc(doc(staff, `orgs/${ORG}/checklistTemplates/tpl1`), { title: 'x' })));
await check('admin creates checklist template', () =>
  assertSucceeds(setDoc(doc(admin, `orgs/${ORG}/checklistTemplates/tpl1`), { title: 'x' })));

await check('outsider admin CANNOT read this org evidence', () =>
  assertFails(getDoc(doc(outsider, `orgs/${ORG}/evidence/evFinal`))));
await check('outsider CANNOT read org doc', () =>
  assertFails(getDoc(doc(outsider, `orgs/${ORG}`))));

await check('live surveyor reads evidence', () =>
  assertSucceeds(getDoc(doc(surveyorLive, `orgs/${ORG}/evidence/evFinal`))));
await check('live surveyor reads auditLog', () =>
  assertSucceeds(getDoc(doc(surveyorLive, `orgs/${ORG}/auditLog/a1`))));
await check('live surveyor CANNOT read checkpoints (token leak)', () =>
  assertFails(getDoc(doc(surveyorLive, `orgs/${ORG}/checkpoints/cp1`))));
await check('live surveyor CANNOT read member roster', () =>
  assertFails(getDoc(doc(surveyorLive, `orgs/${ORG}/members/staff1`))));
await check('live surveyor CANNOT write anything', () =>
  assertFails(setDoc(doc(surveyorLive, `orgs/${ORG}/evidence/evS`), {
    type: 'log', status: 'draft', createdBy: { uid: 'svy1' },
  })));
await check('EXPIRED surveyor claim denies all reads', () =>
  assertFails(getDoc(doc(surveyorExpired, `orgs/${ORG}/evidence/evFinal`))));

console.log('\n' + results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
await env.cleanup();
process.exit(failed === 0 ? 0 : 1);
