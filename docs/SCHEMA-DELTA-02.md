# OpsHub — Schema Delta 02: Registers, Register Checks, Expiration Sweep, Today View
Applies on top of SCHEMA.md v0.1 + Delta 01. Delta only.

Core pattern: **mutable register, immutable snapshots.** The register is the
working document (crash cart contents, supply par list). The ONLY write path
to a register is a completed check, and every check emits an evidence artifact
containing the full before/after snapshot + item diff. Living document AND
tamper-evident history.

---

## New: orgs/{orgId}/registers/{registerId}
```
kind:         "medTray" | "supplyPar" | "equipmentSet"
title:        "Crash cart — OR 1"
checkpointId: string                 // the QR that opens this register's checks
leadTimeDays: 30                     // expiration warning window
criticalDays: 7                      // second-tier escalation window
items: [ {
  key:       "epi-1mg"               // stable identity across replacements
  name:      "Epinephrine 1mg/10mL"
  category:  "medication" | "supply" | "equipment"
  lot:       "4471A" | null
  expiresAt: Timestamp | null        // null = non-expiring (laryngoscope)
  qty:       2
  par:       2
  required:  true                    // missing required item = out-of-range
} ]
lastCheckedAt, lastCheckEvidenceId
version:      number                 // increments on every register mutation
updatedAt
```
- Items as embedded array (crash carts run 30–80 items; well under doc limits).
- `version` gives optimistic-concurrency + a human-readable "register v47" cite.
- Clients NEVER write registers directly (rules: write false). Mutations flow
  through `registerCheck.submit` only.

## Template field type addition: "registerCheck"
A checklist template may declare a single field:
```
{ key: "cartCheck", type: "registerCheck", registerId: "..." }
```
Renders the register as a verification grid — per item:
```
verdict:  "present" | "missing" | "replaced" | "removed"
newLot:   string | null              // when replaced
newExpiresAt: Timestamp | null
newQty:   number | null
note:     string | null
```
Client shows expired items in red, items inside leadTimeDays in amber —
staff cannot submit an "all present" check while an expired required med
sits in the tray without explicitly marking it (the form forces a verdict
per flagged item).

## Evidence payload for register checks
```
payload: {
  templateId, templateVersionHash,
  registerId, registerVersionBefore, registerVersionAfter,
  snapshotBefore: [items],           // full copy — the log page IS this artifact
  snapshotAfter:  [items],
  diff: [ { key, change: "replaced"|"removed"|"qtyChanged", from, to } ],
  exceptions: [ { key, kind: "expired"|"missing"|"belowPar"|"expiringSoon" } ],
  outOfRange: bool,                  // true if any expired/missing required item
  scanContext: { ... }               // as Delta 01
}
```
The rendered "crash cart log" a surveyor sees is a table of these snapshots —
each row a dated, signed, complete inventory state. Better than any paper log:
paper shows initials; this shows the entire tray contents at every check.

## `registerCheck.submit` (callable, replaces direct task completion for these)
Transaction:
1. Load register; verify `registerVersionBefore` matches (reject stale form).
2. Validate verdicts: every item flagged expired/expiring/missing MUST carry
   an explicit verdict; `replaced` requires newLot + newExpiresAt in future.
3. Compute snapshotAfter + diff; write evidence (finalized); bump register
   version; apply item updates; close task; audit.
4. Exceptions with `expired` or `missing` on required items → outOfRange
   side effects (corrective task + notify, per Delta 01 wiring).

## New scheduled function: expirationSweep (nightly, per-org timezone)
For each active register:
- item.expiresAt within `criticalDays` → task "Replace {name} lot {lot} —
  expires {date}" (role: clinicalDirector), notification, dedup key
  `exp:{registerId}:{item.key}:{lot}` so one lot never spawns twice.
- within `leadTimeDays` → same task at normal priority, notify assigned role.
- already expired and still in register → OUT OF RANGE task at urgent priority
  + admin notification. An expired med sitting in a crash cart is a survey
  citation and a patient-safety issue; the system treats it as an incident
  precursor, not a reminder.
Dedup ledger: orgs/{orgId}/sweepLedger/{dedupKey} (system-written).

## New: the Today view (no new storage — pure projection)
Route `/today`. Query: tasks where status == "open" AND dueAt <= end-of-today
(org tz), plus overdue (status open, dueAt < now), plus graceUntil window.
Grouping: Overdue / Due today / Upcoming (48h). Each row:
```
[!] Crash cart check — OR 1          → deep-links to /s/{token} form
[ ] Med fridge temp — Clean utility  → same form the QR opens
[ ] Replace Epinephrine lot 4471A (expires Aug 1)
```
- Per-person filter: assignedUid == me OR assignedRole in my roles.
- Tasks whose obligation sets `requireScan: true` deep-link to a "go scan the
  label" interstitial instead of the form — physical-presence policy is
  per-obligation, not global. (Fridge temps: require scan. Reviewing a policy
  doc: obviously not.)
- Same query powers a morning digest email (Resend, per-role, one email
  listing the day's items with links) — opt-in per member.

## Field additions
- obligations: `requireScan: bool` (default false), `registerId: string|null`
- tasks: `registerId` denormalized; `priority: "normal"|"urgent"`
- evidence: `checkpointId` promoted to TOP-LEVEL field (was only nested in
  scanContext) — mandatory now for log-series and register-history queries.

## Rules delta
```
match /registers/{registerId} {
  allow read: if canRead(orgId);       // surveyors see current tray state
  allow write: if false;               // registerCheck.submit only
}
match /sweepLedger/{key} {
  allow read: if isAdmin(orgId);
  allow write: if false;
}
```

## Indexes (add to firestore.indexes.json)
- tasks: (status ASC, dueAt ASC) ; (assignedRole ASC, status ASC, dueAt ASC)
- evidence: (checkpointId ASC, finalizedAt DESC)
- evidence: (payload.registerId ASC, finalizedAt DESC)  → or promote
  registerId top-level too; recommended: promote it. Flat > nested for
  anything you'll query on. Final call: BOTH checkpointId and registerId
  live top-level on evidence.
