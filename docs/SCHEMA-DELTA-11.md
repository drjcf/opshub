# OpsHub — Schema Delta 11: QA/QI Studies (PDSA / performance-improvement cycle)

The quality-improvement spine. A study runs the AAAHC-expected loop: define a
measurable aim → collect data across periods → analyze against a goal → act →
re-measure → close the loop with documented conclusions. Infection-control
surveillance and incident trending feed studies as data sources. Study
conclusions are reviewed in committee (Delta 12) and finalized as evidence.

## Design principles
- A study is never "done" until the loop is closed: aim, baseline, intervention,
  re-measurement, conclusion. The schema enforces the stages so a survey sees a
  complete cycle, not an orphaned metric.
- Data points are append-only observations; analysis is derived + human-authored.
- Actions (interventions) are tracked to completion — an open action keeps the
  study in "acting" status.
- Everything links to standards (crosswalk) and can be finalized as evidence.

## orgs/{orgId}/qiStudies/{studyId}
```
title:          "Post-op infection rate — reduce SSI"
category:       "infection-control" | "clinical-outcome" | "patient-safety" |
                "medication" | "access" | "patient-experience" | "other"
aim:            string                 // the improvement aim (SMART-ish)
measure:        {                      // what's being measured
  name:         "SSI rate",
  unit:         "%" | "count" | "rate-per-1000" | "minutes" | ...,
  numeratorDef: string,               // what counts in numerator
  denominatorDef: string,
  goal:         number,               // target value
  direction:    "decrease" | "increase" | "maintain",
}
population:      string                 // who/what is studied
frequency:       "monthly" | "quarterly" | "per-case" | "weekly"
standardRefs:    [ {editionId, code} ]  // AAAHC standards this study addresses
status:          "planning" | "collecting" | "analyzing" | "acting" |
                 "remeasuring" | "closed"
baseline:        { value, period, note } | null
owner:           Actor
startedAt, closedAt
conclusion:      string | null          // the closed-loop summary
outcome:         "goal-met" | "improved" | "no-change" | "worsened" | null
evidenceId:      string | null          // finalized study report as evidence
summary:         {                       // denormalized latest for the list view
  latestValue, latestPeriod, dataPointCount, openActionCount, goalMet
}
```

## orgs/{orgId}/qiStudies/{studyId}/dataPoints/{pointId}
Append-only measurements.
```
period:      "2026-Q2" | "2026-07" | ISO date
value:       number
numerator:   number | null
denominator: number | null
note:        string
enteredBy:   Actor, enteredAt
source:      "manual" | "incident-derived" | "log-derived"  // provenance
sourceRef:   string | null              // e.g. an incident/log id if derived
```

## orgs/{orgId}/qiStudies/{studyId}/actions/{actionId}
Interventions / corrective actions in the "act" phase.
```
description: string
assignedTo:  Actor | null
dueDate:     Timestamp | null
status:      "open" | "in-progress" | "done" | "cancelled"
completedAt: Timestamp | null
result:      string | null              // what the action achieved
createdBy:   Actor, createdAt
```

## orgs/{orgId}/qiStudies/{studyId}/analyses/{analysisId}
Human-authored analysis notes at a point in the cycle (baseline read,
post-intervention read, trend interpretation).
```
phase:       "baseline" | "interim" | "post-intervention" | "final"
narrative:   string                     // the interpretation
periodsCovered: [ "2026-Q1", "2026-Q2" ]
authoredBy:  Actor, authoredAt
```

## Callables (qi.js)
- qi.createStudy        (admin/CD; defines aim + measure + goal)
- qi.addDataPoint       (staff+; append a measurement; updates summary)
- qi.addAction          (admin/CD; log an intervention)
- qi.updateAction       (admin/CD; progress/close an action)
- qi.addAnalysis        (admin/CD; author an analysis note)
- qi.advanceStatus      (admin/CD; move through PDSA stages, with guards:
                        can't close with open actions or no conclusion)
- qi.closeStudy         (admin/CD; requires conclusion + outcome; finalizes a
                        study report as EVIDENCE, links evidenceId)

## Closure guard (the loop-closing rule)
qi.closeStudy refuses unless: baseline set, ≥1 post-intervention data point,
a final analysis exists, no open actions, conclusion + outcome provided. This
is what makes a surveyor see a *complete* cycle rather than an open metric.

## Rules delta
```
match /qiStudies/{studyId} {
  allow read: if canRead(orgId);          // surveyors see QI (it's the point)
  allow write: if false;                   // qi callables only
  match /{sub=**} {
    allow read: if canRead(orgId);
    allow write: if false;
  }
}
```

## Feeds (later modules)
- Incidents (Delta 13) can push a dataPoint with source:"incident-derived".
- Infection-control logs (hand hygiene, spore tests) can roll into an
  infection-control study as source:"log-derived".
- Committee review (Delta 12) references the study; minutes cite its conclusion.
```
