# OpsHub — Schema Delta 12: Committees & Meeting Minutes

The governance loop. Recurring committees (QI, safety, governance, P&T) hold
meetings that run a templated agenda, record attendance and minutes, reference
the QI studies / incidents reviewed, and finalize minutes as IMMUTABLE
evidence. A surveyor asks "show me your QI committee minutes" — this produces
them, mapped to standards, with the review trail intact.

## Design principles
- A **meeting template** defines the agenda structure (ordered sections:
  call-to-order, prior-minutes approval, QI review, standing items, new
  business, action items, adjournment). Recurring committees reuse it so every
  meeting's minutes have consistent structure — and a template EDITOR lets you
  build/modify these.
- A **meeting** instantiates a template, fills each section, records attendance,
  and links reviewed items (QI studies, incidents, documents).
- **Minutes finalize as evidence** — once approved, immutable, timestamped,
  attributed, standard-mapped (the minutesEvidenceId hook from the base schema).
- Prior-minutes approval chains meetings (this meeting approves last meeting's
  minutes — the governance continuity a survey checks).

## orgs/{orgId}/committees/{committeeId}
```
name:         "Quality Improvement Committee"
purpose:      string
cadence:      "monthly" | "quarterly" | "annual" | "ad-hoc"
members:      [ { uid, name, role } ]      // committee roster (roles: chair, member, secretary)
chairUid:     string | null
templateId:   string | null                // default meeting template
standardRefs: [ {editionId, code} ]
status:       "active" | "inactive"
createdBy:    Actor, createdAt
```

## orgs/{orgId}/meetingTemplates/{templateId}
The agenda structure. Editable via the template editor.
```
name:         "Standard QI Committee Agenda"
sections:     [ {
  key:        "call_to_order",
  title:      "Call to Order",
  type:       "text" | "attendance" | "priorMinutes" | "qiReview" |
              "actionItems" | "checklist" | "vote",
  prompt:     string,                       // guidance for the minute-taker
  required:   boolean,
} ]
version:      number
active:       boolean
createdBy:    Actor, updatedAt
```
Section **types** drive the minutes UI:
- text: freeform narrative
- attendance: present/absent from committee roster (quorum check)
- priorMinutes: approve prior meeting's minutes (motion + vote)
- qiReview: link + summarize QI studies reviewed
- actionItems: assign follow-ups (become tracked tasks)
- checklist: yes/no items (e.g. standing compliance confirmations)
- vote: a motion with for/against/abstain

## orgs/{orgId}/committees/{committeeId}/meetings/{meetingId}
```
templateId:   string
templateSnapshot: { sections }              // frozen at meeting creation
date:         Timestamp
location:     string
attendance:   [ { uid, name, status: "present"|"absent"|"excused" } ]
quorumMet:    boolean
sections:     { [sectionKey]: { ...filled content per type } }
reviewedStudyIds: [ ]                        // QI studies discussed
reviewedIncidentIds: [ ]
actionItems:  [ { description, assignedTo, dueDate, status } ]
priorMinutesApproved: boolean | null
status:       "draft" | "finalized"
minutesEvidenceId: string | null            // set when finalized
chairUid, secretaryUid
createdBy, createdAt, finalizedBy, finalizedAt
```

## Callables (committees.js)
- committee.create / committee.update      (admin; roster, chair, cadence)
- meetingTemplate.save                      (admin; create/edit agenda template — validated)
- meetingTemplate.retire                    (admin)
- meeting.create                            (admin/CD/chair; snapshots template)
- meeting.saveSection                       (secretary+; fill a section, draft only)
- meeting.setAttendance                     (secretary+; quorum auto-computed)
- meeting.finalizeMinutes                   (chair/admin; requires attendance +
                                            required sections filled; writes an
                                            immutable minutes evidence artifact;
                                            spawns action-item tasks)

## Finalize guard (governance completeness)
finalizeMinutes refuses unless: attendance recorded, quorum status set, all
required sections filled, a chair present. On success: creates evidence
(type: "minutes"), sets minutesEvidenceId, and materializes any actionItems as
tracked tasks assigned to their owners.

## Rules delta
```
match /committees/{committeeId} {
  allow read: if canRead(orgId);            // surveyors see committee structure
  allow write: if false;                     // committee callables only
  match /meetings/{meetingId} {
    allow read: if canRead(orgId);
    allow write: if false;
  }
}
match /meetingTemplates/{templateId} {
  allow read: if canRead(orgId);
  allow write: if false;                     // meetingTemplate callables only
}
```

## Governance loop closure
QI study (Delta 11) closes → reviewed in a committee meeting → minutes cite it
and record the committee's acceptance → minutes finalized as evidence. That
chain (improvement → governance review → documented acceptance) is exactly
what AAAHC wants to see, and it's now traceable end to end.
```
