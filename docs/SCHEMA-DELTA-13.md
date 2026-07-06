# OpsHub — Schema Delta 13: Incidents / Occurrence Reporting

The safety-event loop that feeds QI. Any staff member reports an occurrence
(adverse event, near-miss, complaint, equipment failure, medication error);
it's triaged, investigated, corrective actions are tracked, and it closes
immutably. Closed incidents can push a data point into a QI study
(source: "incident-derived"), and trends become the input to improvement work.

## Design principles
- **Low-friction reporting**: any staff member can file, fast. Near-misses
  matter as much as harm events — a good safety culture reports both.
- **De-identified by schema**: incidents track WHAT happened, not patient
  identity. No PHI fields. A patient reference, if needed, is a free-text
  case marker the practice controls — never structured PHI.
- **Investigate → act → close**: mirrors the QI action pattern. Corrective
  actions are tracked to completion; an open action keeps the incident open.
- **Closed = immutable**: a closed incident is a record. Reopening requires a
  new linked incident, not an edit.
- **Feeds QI**: closing (or any point) can contribute a measurement to a study,
  so incident frequency/severity becomes trended quality data.

## orgs/{orgId}/incidents/{incidentId}
```
refNumber:    "INC-2026-0007"            // human-friendly, sequential per year
type:         "adverse-event" | "near-miss" | "medication-error" |
              "equipment-failure" | "complaint" | "fall" | "infection" |
              "security" | "other"
severity:     "no-harm" | "minor" | "moderate" | "severe" | "sentinel"
title:        string
description:   string                     // what happened (de-identified)
occurredAt:   Timestamp
location:     string                      // OR 1, recovery, waiting room…
caseMarker:   string | null              // practice-controlled ref, NOT PHI
reportedBy:   Actor, reportedAt
status:       "reported" | "investigating" | "action" | "closed"
standardRefs: [ {editionId, code} ]

// investigation (added during 'investigating')
investigation: {
  findings:   string,
  rootCause:  string,
  contributingFactors: [ string ],
  investigatedBy: Actor, investigatedAt,
} | null

// closure
closedBy:     Actor | null, closedAt
outcome:      string | null              // resolution summary
qiStudyId:    string | null              // if fed into a study
evidenceId:   string | null              // finalized incident report as evidence
```

## orgs/{orgId}/incidents/{incidentId}/actions/{actionId}
Corrective/preventive actions (CAPA).
```
description:  string
type:         "corrective" | "preventive"
assignedTo:   Actor | null
dueDate:      Timestamp | null
status:       "open" | "in-progress" | "done" | "cancelled"
completedAt:  Timestamp | null
result:       string | null
createdBy:    Actor, createdAt
```

## Callables (incidents.js)
- incident.report          (staff+; file a new occurrence; assigns refNumber)
- incident.setInvestigation(admin/CD; findings, root cause, factors)
- incident.addAction       (admin/CD; a CAPA item)
- incident.updateAction    (admin/CD; progress/close)
- incident.advanceStatus   (admin/CD; reported→investigating→action)
- incident.close           (admin/CD; requires investigation + no open actions +
                           outcome; finalizes an incident report as evidence)
- incident.feedToQI        (admin/CD; push a data point into a QI study, tagged
                           source:"incident-derived", sourceRef=incidentId)

## Close guard
incident.close refuses unless: investigation recorded (findings + root cause),
no open corrective actions, outcome provided. On success: writes an immutable
incident-report evidence artifact and sets evidenceId. (Sentinel events may
warrant deeper RCA — the guard ensures at minimum a documented cause + closure.)

## refNumber generation
Sequential per year via a counter doc at orgs/{orgId}/counters/incidents-{year}
incremented in a transaction, formatted INC-{year}-{seq4}.

## Rules delta
```
match /incidents/{incidentId} {
  allow read: if canRead(orgId);          // surveyors see safety program
  allow write: if false;                   // incident callables only
  match /actions/{actionId} {
    allow read: if canRead(orgId);
    allow write: if false;
  }
}
```
(Tightened from the shell's client-write to callable-only, matching QI/committees.)

## The trio, closed
Incident reported → investigated → CAPA tracked → closed as evidence → fed as a
data point into a QI study → studied/improved → reviewed in committee → minutes
finalized. Occurrence data becomes quality data becomes governance record.
That's the full AAAHC quality-and-safety loop, traceable end to end.
```
