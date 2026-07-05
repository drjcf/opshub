# OpsHub — Schema Delta 07: AAAHC v44 Citation Model (corrects Delta base + 06)
Applies on top of prior deltas. Supersedes the assumed chapter/roman/letter
citation shape with the ACTUAL AAAHC v44 structure, confirmed by inspecting
the licensee's own handbook (structure only; no text ingested by OpsHub).

## Real v44 structure (from inspection)
- **Domain**: 3-letter prefix — ADM (Administration), ASG, BEH (Behavioral
  Health), and others (each chapter/subchapter is a domain code).
- **Standard**: `PREFIX.NNN` — e.g. `ADM.150`, `ASG.160`. NNN is a
  zero-anchored number (100, 130, 140, 150…).
- **Element**: `PREFIX.NNN.SS` — e.g. `ASG.160.10`, `.20`, `.30`. Sub-codes
  in tens. A standard may have 0..n elements.
- **Guidance**: a "Guidance & Evidence" block with bulleted items follows a
  standard. Supplementary interpretation, not normative text. Structurally
  distinct — parsed separately, flagged as guidance.
- Layout is two-column: code/label at x≈57–62, element text at x≈136.

## Revised global reference tree (citations only — still NO handbook text)
### standardsEditions/{editionId}
```
editionId:  "aaahc-v44"              // was aaahc-2026; key now matches version
label:      "AAAHC Accreditation Handbook v44 (2025), Ambulatory"
programType:"ambulatory"
status:     "current"
```

### standardsEditions/{editionId}/domains/{domainCode}
NEW level — the 3-letter category.
```
code:       "ASG"
name:       "Anesthesia / Surgical Services"   // paraphrased label, not verbatim
order:      number
```

### standardsEditions/{editionId}/standards/{standardId}
Doc ID = full code with dots→dashes for path-safety: `ASG-160`.
```
code:       "ASG.160"               // display
domain:     "ASG"
number:     160
shortRef:   "Patient selection for sedation"   // YOUR paraphrase, not AAAHC text
elementCodes: ["ASG.160.10","ASG.160.20","ASG.160.30"]  // just the codes
order:      "ASG.160"
```
Elements are NOT separate reference docs — they're listed by code on the
standard, and the licensee's OWN text for each lives in handbookEntries
(Delta 06), keyed by the element code. Keeps the shipped tree citation-only.

## handbookEntries revision (Delta 06) — element-level text
Doc ID = element or standard code (dashes): `ASG-160-10`.
```
code:        "ASG.160.10"           // element (or "ASG.160" for standard-level)
standardCode:"ASG.160"
domain:      "ASG"
kind:        "standard" | "element" | "guidance"
text:        string                  // licensee's OWN handbook text
pageRef:     "p. 52" | null
enteredBy:   Actor, enteredAt
```
`kind: "guidance"` lets the browser show normative element text and
AAAHC guidance separately — guidance is interpretive and a licensee may
choose not to store it.

## obligations.standardRefs — now reference element or standard codes
```
standardRefs: [ { editionId: "aaahc-v44", code: "ASG.160" } ]
```
(was {editionId, standardId} — `code` is clearer and matches the crosswalk.)
Migration: existing seed refs (aaahc-2026 / 10-I-C) get remapped by the
reseed script; no production data yet, so this is a clean cutover.

## Parser output contract (handbook.ingestFromUpload, tuned to v44)
The in-tenant extractor produces, per detected code:
```
{ code, kind, standardCode, domain, pageRef, text }   // text = licensee's own
```
Segmentation rules (from the real layout):
- A line whose leading token matches /^[A-Z]{3}\.\d{2,3}(\.\d{2})?/ starts a
  new code block; text is the same-row right-column (x≈136) plus following
  wrapped lines until the next code or a "Guidance" marker.
- "Guidance & Evidence" begins a guidance block: subsequent "• …" bullets
  are captured as kind:"guidance" under the current standard.
- Domain header = a bare 3-letter code line at large size (sz≥10) with a
  name following → upserts a domain doc.
All extraction runs in the licensee's tenant; text is staged as draft
handbookEntries for review, never auto-committed, never logged.

## Seeding the citation tree (your side, ships with product)
A `seed-standards-v44.js` builds domains + standards + elementCodes from the
CODE STRUCTURE ONLY (the PREFIX.NNN.SS tokens — reference labels, not
copyrightable), plus YOUR paraphrased shortRefs. This is the one place the
tree is populated; it contains zero AAAHC prose. The licensee's own text
attaches at runtime via handbookEntries.
```
