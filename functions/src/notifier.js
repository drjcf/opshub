// functions/src/notifier.js
// Two paths:
//  1. onNotificationCreated — drains the notifications queue (out-of-range,
//     expirations, assignments) to email via Resend, immediately.
//  2. morningDigest — 06:00 org-local daily email per member: today's tasks.
// RESEND_API_KEY via functions secret; APP_HOST via env for deep links.

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import { db, FieldValue, Timestamp } from './util.js';

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const APP_HOST = defineString('APP_HOST', { default: 'https://opshub.example.app' });

async function sendEmail(apiKey, { to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'OpsHub <notify@transactional.example.com>', to, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

async function emailsForRole(orgId, role) {
  const snap = await db
    .collection(`orgs/${orgId}/members`)
    .where('active', '==', true)
    .where('roles', 'array-contains', role)
    .get();
  return snap.docs.map((d) => d.get('email')).filter(Boolean);
}

const KIND_COPY = {
  outOfRange: (n) => ({
    subject: '⚠ Out-of-range condition recorded',
    line: 'An out-of-range condition was recorded and a corrective-action task was created.',
  }),
  expiredInUse: () => ({
    subject: '🔴 EXPIRED item in active use',
    line: 'An expired item was found on an active register. Remove and replace immediately.',
  }),
  expiringCritical: () => ({
    subject: 'Item expiring within critical window',
    line: 'A register item enters its critical expiration window. A replacement task is on the board.',
  }),
  trainingAssigned: () => ({
    subject: 'Training assigned',
    line: 'New training has been assigned to you. It appears on your Today list.',
  }),
  trainingExpiring: () => ({
    subject: 'Certification expiring soon',
    line: 'A certification or training credential is approaching expiration.',
  }),
  catalogUpdates: () => ({
    subject: 'Course content updates available',
    line: 'Updated stock course packages are available for review and import.',
  }),
};

export const onNotificationCreated = onDocumentCreated(
  { document: 'orgs/{orgId}/notifications/{noteId}', secrets: [RESEND_API_KEY] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const note = snap.data();
    if (note.sentAt) return;
    const { orgId } = event.params;

    const copy = (KIND_COPY[note.kind] ?? (() => ({
      subject: 'OpsHub notification',
      line: `Event: ${note.kind}`,
    })))(note);

    const recipients = note.toUid
      ? (await db.collection(`orgs/${orgId}/members`).where('__name__', '==', note.toUid).get())
          .docs.map((d) => d.get('email')).filter(Boolean)
      : await emailsForRole(orgId, note.toRole ?? 'admin');

    if (recipients.length === 0) {
      await snap.ref.update({ sentAt: FieldValue.serverTimestamp(), sendError: 'no recipients' });
      return;
    }

    const link = `${APP_HOST.value()}/today`;
    try {
      await sendEmail(RESEND_API_KEY.value(), {
        to: recipients,
        subject: copy.subject,
        html: `<p>${copy.line}</p><p><a href="${link}">Open OpsHub</a></p>`,
      });
      await snap.ref.update({ sentAt: FieldValue.serverTimestamp() });
    } catch (e) {
      await snap.ref.update({ sendError: String(e) });
      throw e; // retry via function retry policy
    }
  }
);

// Morning digest — 06:00 deployment-local. Parameterize tz per licensee.
export const morningDigest = onSchedule(
  { schedule: '0 6 * * *', timeZone: 'Pacific/Honolulu', secrets: [RESEND_API_KEY] },
  async () => {
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    const orgs = await db.collection('orgs').where('status', '==', 'active').get();
    for (const orgDoc of orgs.docs) {
      const orgId = orgDoc.id;

      const open = await db
        .collection(`orgs/${orgId}/tasks`)
        .where('status', '==', 'open')
        .where('dueAt', '<=', Timestamp.fromDate(endOfToday))
        .orderBy('dueAt')
        .limit(200)
        .get();
      if (open.empty) continue;

      const members = await db
        .collection(`orgs/${orgId}/members`)
        .where('active', '==', true)
        .get();

      for (const m of members.docs) {
        const member = m.data();
        if (member.digestOptOut || !member.email) continue;
        const mine = open.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter(
            (t) =>
              t.assignedUid === m.id ||
              (!t.assignedUid && (member.roles ?? []).includes(t.assignedRole))
          );
        if (mine.length === 0) continue;

        const overdue = mine.filter((t) => t.dueAt.toMillis() < Date.now());
        const rows = mine
          .map((t) => {
            const late = t.dueAt.toMillis() < Date.now() ? ' ⚠' : '';
            return `<li>${t.title}${late}</li>`;
          })
          .join('');

        await sendEmail(RESEND_API_KEY.value(), {
          to: [member.email],
          subject: `Today: ${mine.length} item${mine.length === 1 ? '' : 's'}${
            overdue.length ? ` (${overdue.length} overdue)` : ''
          }`,
          html: `<p>Your compliance items for today:</p><ul>${rows}</ul>
                 <p><a href="${APP_HOST.value()}/today">Open the Today board</a></p>`,
        });
      }
    }
  }
);
