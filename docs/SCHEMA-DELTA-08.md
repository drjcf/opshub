# OpsHub — Schema Delta 08: Self-Assessment / Mock Survey Scoring

Turns the parsed v44 structure (elements + Rating scales + Selective/Universal
designators) into a survey-style self-assessment: rate each element against its
real AAAHC scale, see supporting evidence alongside, roll up element → standard
→ domain → overall, with a standard-level override for surveyor judgment.

## Concepts
- **Assessment**: a dated self-assessment run (like a mock survey cycle). You
  can have several over time to show trend/readiness.
- **Element rating**: for each element, a rating on ITS scale (Yes/No, or the
  standard's FC/PC/NC-family scale), plus optional note + linked evidence.
- **Standard rollup**: derived from element ratings by a rule, but an admin/CD
  may OVERRIDE with a manual standard-level rating + justification.
- **Coverage vs. rating**: evidence coverage (from the crosswalk) is shown as
  SUPPORT next to each item, but the human assigns the rating — evidence
  informs, it doesn't auto-decide (the Liability Rule).

## Rating scales (from parsed data)
Each element/standard carries a `rating` string parsed from the handbook, e.g.
"Yes, No" or "FC, PC, NC" or "FC, SC, MC, NC". We parse that into an ordered
options list. Compliance mapping (for rollup math):
- Yes / FC (Full Compliance)        -> compliant (1.0)
- SC (Substantial Compliance)       -> partial (0.75)
- PC (Partial Compliance)           -> partial (0.5)
- MC (Minimal Compliance)           -> partial (0.25)
- No / NC (Non-Compliance)          -> noncompliant (0.0)
- N/A                               -> excluded from rollup
Mapping table lives in code (RATING_MAP) so new scales are easy to add.

## Collections

### orgs/{orgId}/assessments/{assessmentId}
```
edition:      "aaahc-2026"
title:        "Q3 2026 Self-Assessment"
status:       "in_progress" | "complete" | "archived"
startedBy:    Actor, startedAt
completedAt:  Timestamp | null
summary:      {                       // denormalized rollup, updated on rate
  overall: 0.82,                      // 0..1 weighted compliance
  byDomain: { ADM: 0.9, ASG: 0.75, ... },
  counts: { compliant, partial, noncompliant, unrated, na }
}
```

### orgs/{orgId}/assessments/{assessmentId}/ratings/{code}
One doc per rated ITEM (element or standard). Doc ID = code with dashes.
```
code:         "ASG.160.10"
standardCode: "ASG.160"
domain:       "ASG"
kind:         "element" | "standard"
scale:        ["Yes","No"]           // parsed options for this item
rating:       "Yes" | "No" | "N/A" | null
compliance:   1.0 | 0.5 | 0.0 | null // derived from rating via RATING_MAP
note:         string
evidenceIds:  [ "..." ]              // evidence linked as support
ratedBy:      Actor, ratedAt
}
```

### Standard-level override
Stored as a rating doc with kind:"standard" and an `override:true` flag +
`justification`. If present, the standard's rollup uses the override instead of
the derived element average.
```
override:      true
overrideRating:"PC"
justification: string
```

## Rollup rule
- Standard compliance = override if set, else mean(element compliance) over
  rated, non-N/A elements. Unrated elements flagged (not counted as 0, but
  surfaced as "incomplete").
- Domain = mean(standard compliance) over rated standards.
- Overall = mean(domain).
- Universal vs Selective: Selective standards that the org marks "not
  applicable to our services" are excluded (AAAHC selective standards apply
  only to services offered). A per-assessment `applicability` map on the
  assessment doc records which selective standards are in scope.

## Callables
- assessment.create      (admin/CD; snapshots current edition's standards)
- assessment.rateItem    (staff+; sets element/standard rating + evidence links)
- assessment.overrideStandard (admin/CD; manual standard rating + justification)
- assessment.setApplicability (admin/CD; mark selective standards in/out of scope)
- assessment.complete    (admin/CD; freezes + writes final summary)
Rollup recomputed server-side on each rate (small enough per standard) or on
complete for the full pass.

## Rules delta
```
match /assessments/{aid} {
  allow read: if canRead(orgId);
  allow write: if false;                 // callables only
  match /ratings/{code} {
    allow read: if canRead(orgId);
    allow write: if false;               // rateItem/override callables only
  }
}
```
Surveyors (read-only) CAN see assessments — a completed self-assessment is
exactly what you'd show a surveyor to demonstrate readiness.

## The payoff
A Selective/Universal-aware, evidence-supported, element-to-domain scored
mock survey — the same instrument AAAHC uses, run internally before the real
thing. Trends across assessments show readiness improving over time.
