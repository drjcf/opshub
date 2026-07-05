// functions/src/handbook-parse.js — AAAHC v44 extraction, column-aware.
// Real layout (confirmed by inspection): three columns —
//   Identifier (x~55-65) | Requirement (x~135) | Rating (x~475-500)
// Codes nest up to FOUR levels: DOMAIN.NNN[.SS[.T]]
//   FAC.270  (standard) -> FAC.270.10 (element) -> FAC.270.10.1 (sub-element)
// A "Universal" / "Selective / N" designator sits under the standard code.
// Rating column holds the survey scale (FC/PC/NC, Yes/No) — kept as metadata.
//
// Pure function; no I/O. Text captured is the LICENSEE'S OWN handbook copy.

const CODE_RE = /^([A-Z]{3})\.(\d{2,3})(?:\.(\d{1,2}))?(?:\.(\d{1,2}))?$/;
const DESIGNATOR_RE = /^(Universal|Selective\s*\/?\s*\d*|Adjunct)/i;

// Column boundaries (from x-position inspection). Requirement is the middle
// band; anything at/after RATING_X is the rating scale, not text.
const REQ_MIN_X = 120;
const RATING_MIN_X = 460;

// Group a page's text items into rows (by y), each row keeping per-item x.
export function rowsFromContent(content, pageNum) {
  const rows = {};
  for (const it of content.items) {
    if (!it.str.trim()) continue;
    const y = Math.round(it.transform[5]);
    (rows[y] ||= []).push({ x: Math.round(it.transform[4]), s: it.str, size: it.transform[0] });
  }
  return Object.keys(rows).sort((a, b) => b - a).map((y) => ({
    page: pageNum,
    items: rows[y].sort((a, b) => a.x - b.x),
  }));
}

// Split a row's items into the three columns by x-position.
function splitColumns(items) {
  const idParts = [], reqParts = [], rateParts = [];
  for (const it of items) {
    if (it.x >= RATING_MIN_X) rateParts.push(it.s);
    else if (it.x >= REQ_MIN_X) reqParts.push(it.s);
    else idParts.push(it.s);
  }
  return {
    id: idParts.join('').trim(),
    req: reqParts.join(' ').replace(/\s+/g, ' ').trim(),
    rate: rateParts.join(' ').replace(/\s+/g, ' ').trim(),
  };
}

export function parseHandbookRows(rows) {
  const domains = new Map();
  const entries = new Map();
  let cur = null;         // code currently accumulating requirement text
  let order = 0;

  const ensure = (code, kind, standardCode, domain, page) => {
    if (!entries.has(code)) {
      entries.set(code, {
        code, kind, standardCode, domain,
        pageRef: page ? `p. ${page}` : null,
        text: '', rating: '', designator: '',
      });
    }
    return entries.get(code);
  };

  for (const row of rows) {
    // Domain banner: a 3-letter code + name, large size, alone at left.
    const joined = row.items.map((i) => i.s).join('').trim();
    const domHeader = joined.match(/^([A-Z]{3})\s+([A-Za-z].{2,60})$/);
    const bigSize = Math.max(...row.items.map((i) => i.size || 0)) >= 11;
    if (domHeader && bigSize && !CODE_RE.test(domHeader[1])) {
      const [, code, name] = domHeader;
      if (!domains.has(code)) domains.set(code, { code, name: name.trim(), order: order++ });
      cur = null;
      continue;
    }

    // Skip the column-header row ("Identifier Requirement Rating").
    if (/^Identifier/i.test(joined)) { cur = null; continue; }

    const { id, req, rate } = splitColumns(row.items);
    const m = id.match(CODE_RE);

    if (m) {
      const [, domain, n1, n2, n3] = m;
      const standardCode = `${domain}.${n1}`;
      const code = id;
      const kind = n3 ? 'subelement' : n2 ? 'element' : 'standard';
      if (!domains.has(domain)) domains.set(domain, { code: domain, name: '', order: order++ });
      const e = ensure(code, kind, standardCode, domain, row.page);
      if (req) e.text = (e.text ? e.text + ' ' : '') + req;
      if (rate) e.rating = rate;
      cur = code;
      continue;
    }

    // A designator line ("Universal" / "Selective / 2") under the current code.
    if (DESIGNATOR_RE.test(id) && cur) {
      entries.get(cur).designator = id.trim();
      // designator rows may also carry a wrapped rating (e.g. "MC, NC")
      if (rate) entries.get(cur).rating = (entries.get(cur).rating + ' ' + rate).trim();
      continue;
    }

    // Continuation: requirement text wrapping to a new line (no code in col 1).
    if (cur && req) {
      entries.get(cur).text += ' ' + req;
    }
    // wrapped rating with no code and no req
    else if (cur && rate && !req) {
      entries.get(cur).rating = (entries.get(cur).rating + ' ' + rate).trim();
    }
  }

  return {
    domains: [...domains.values()],
    entries: [...entries.values()].map((e) => ({ ...e, text: e.text.trim() })),
  };
}

// Citation-only tree (codes + structure, NO text) for the shipped reference.
export function citationTreeFromParse(parse) {
  const standards = new Map();
  for (const e of parse.entries) {
    const sc = e.standardCode;
    if (!standards.has(sc)) {
      standards.set(sc, {
        code: sc, domain: sc.split('.')[0], number: Number(sc.split('.')[1]) || 0,
        elementCodes: [], order: sc,
      });
    }
    if (e.kind === 'element' || e.kind === 'subelement') {
      standards.get(sc).elementCodes.push(e.code);
    }
  }
  return { domains: parse.domains, standards: [...standards.values()] };
}
