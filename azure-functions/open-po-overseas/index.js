// Open purchase-order lines for the overseas vendor list.
//
// Feeds the MAC HTS / Tariff Impact dashboard, which previously read a
// SharePoint workbook. Returns one row per open PO line (ordered > received).
//
// GET  /api/open-po-overseas?code=<key>
// POST /api/open-po-overseas?code=<key>   body: { vendors?: string[] }
//
// The vendor list below is the "overseas vendors" definition and is the
// default; POST a `vendors` array to override it for ad-hoc queries.

const sql = require('mssql');
const { withQuery } = require('../shared/db');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

// Overseas vendors whose POs carry tariff exposure.
const DEFAULT_VENDORS = [
  'V1A021', 'V1M005', 'V1E156', 'V1F661', 'V1K240', 'V1P168',
  'V1N203', 'V1S208', 'V1R035', 'V1S204', 'V1S205', 'V1W045',
  'V1S248', 'V1T044', 'V1Z065', 'V1N303', 'V1Y080', 'V1I085', 'V1I172',
];

// Only genuinely open orders. An allow-list rather than a list of closed
// statuses to exclude: the exclusion form let STARTED and ON HOLD through,
// which are not open positions and should not carry tariff exposure here.
const OPEN_STATUSES = ['OPEN'];

/**
 * Country of origin for vendors whose APVEND record has the field blank.
 *
 * Duty rates depend on origin — Section 301 is China-only, Section 232 has
 * UK-specific rates — so a line cannot be priced without one. These are a
 * stopgap so the dashboard is not blocked on data entry; the real fix is to
 * fill in APVEND, after which the entry here can be deleted.
 *
 * Keyed by vendor number, value must match a name the dashboard and scraper
 * can map to an ISO code.
 */
const VENDOR_COUNTRY_OVERRIDES = {
  V1E156: 'Czech Republic',   // ELEKTROLINE INC
  V1P168: 'Spain',            // MOSDORFER RAIL LTD.   — per Michelle Soares
  V1S248: 'India',            // SIGMA TERMINALS, LLP  — per Michelle Soares
};

/**
 * Charge lines that are not imported goods, so carry no HTS code by nature.
 *
 * Deliberately a short, named list rather than a clever rule. An earlier
 * attempt excluded any part number without digits, which also dropped
 * BRACKET-TOP, CLEATA-NSP and CLEATBFILLER — real parts with real tariff
 * exposure. Add to this list as more charge lines turn up.
 *
 * FRIEGHT is the transposition that appears in the live data.
 */
const NON_MATERIAL_WORDS = ['PACKAGING', 'MATERIAL CERT', 'FREIGHT', 'FRIEGHT'];

const NON_MATERIAL_RE = new RegExp(`(^|[^A-Z])(${NON_MATERIAL_WORDS.join('|')})([^A-Z]|$)`, 'i');

function isNonMaterial(partNo) {
  const p = String(partNo || '').trim().toUpperCase();
  if (!p) return true;
  return NON_MATERIAL_RE.test(p);
}

/**
 * Pull an HTS code out of the item master's free-text comment.
 *
 * M2M has no HTS field, so it is recorded in INMASTX.FCOMMENT alongside
 * unrelated notes, e.g.:
 *
 *   .45 lbs each
 *   AMP: 325821
 *   HTS #7419.99.5050 0%
 *
 * We must return 7419.99.5050 and nothing else — not the weight, not the AMP
 * number, and not the duty percentage that often trails the code.
 *
 * Strategy: prefer a code introduced by an explicit "HTS" marker; otherwise
 * fall back to a strictly-dotted code anywhere in the text. Validate by digit
 * count, since HTS codes are 6, 8 or 10 digits — that rejects part numbers,
 * weights and percentages, which never take that shape.
 */
function extractHtsCode(comment) {
  if (!comment) return null;
  const text = String(comment);

  // Candidates are kept with their position so the code written FIRST wins.
  // Comments sometimes list several — "HTS CODE 9903.78.01 - 50% tariff ...
  // 9903.03.06 7407.10.5050" — and the leading one is the operative code.
  const candidates = [];

  // Pass 1: anything following an "HTS" marker — "HTS #", "HTS:", "HTS CODE".
  // HST and HTC are accepted too: both typos occur in the live item comments,
  // and without them those codes survive only by the dotted-pattern fallback.
  const marker = /\b(?:HTS|HST|HTC)\s*(?:CODE)?\s*[#:\-]?\s*([0-9][0-9.\s-]*)/gi;
  let m;
  while ((m = marker.exec(text)) !== null) candidates.push({ raw: m[1], at: m.index });

  // Pass 2: a dotted code anywhere, for comments with no marker.
  //
  // Accepts the four-group form as well: comments are written both as
  // 3506.10.1000 and 3506.10.10.00. They are the same ten digits, and matching
  // only three groups truncated the second form to eight — which then looked
  // like an incomplete classification rather than a punctuation difference.
  const dotted = /\b(\d{4}\.\d{2}(?:\.\d{2,4})?(?:\.\d{2})?)\b/g;
  while ((m = dotted.exec(text)) !== null) candidates.push({ raw: m[1], at: m.index });

  candidates.sort((a, b) => a.at - b.at);

  for (const { raw } of candidates) {
    // Stop at the first whitespace run: "7419.99.5050 0%" -> "7419.99.5050",
    // which is what keeps the trailing duty rate out of the result.
    const head = raw.trim().split(/[\s ]+/)[0];
    const digits = head.replace(/\D/g, '');

    // 6/8/10 digits are the real HTS levels. Anything else is some other number
    // that happened to sit near the marker.
    if (![6, 8, 10].includes(digits.length)) continue;

    const formatted =
      digits.length === 10 ? `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}`
      : digits.length === 8 ? `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}`
      : `${digits.slice(0, 4)}.${digits.slice(4)}`;

    // First code written wins — including Chapter 99 provisions, which some
    // comments lead with deliberately.
    return formatted;
  }

  return null;
}

module.exports = async function (context, req) {
  if (req.method === 'OPTIONS') {
    context.res = {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      },
    };
    return;
  }

  try {
    const connString = process.env.M2M_CONNECTION_STRING;
    if (!connString) {
      context.res = {
        status: 500,
        headers: CORS,
        body: JSON.stringify({ error: 'M2M database connection is not configured.' }),
      };
      return;
    }

    // ?inspectPart=<partno> dumps every INMASTX row for one part, to see which
    // row a comment actually lives on when the dashboard says a code is absent.
    const inspectPart = req.query && req.query.inspectPart;
    if (inspectPart) {
      const rows = await withQuery(connString, async (request) => {
        request.input('p', sql.VarChar, String(inspectPart).trim());
        const r = await request.query(`
          SELECT im.FPARTNO AS [PartNo], im.FAC AS [Facility], im.FREV AS [Rev],
                 CAST(im.FCOMMENT AS VARCHAR(4000)) AS [Comment]
          FROM INMASTX im
          WHERE LTRIM(RTRIM(im.FPARTNO)) = @p
        `);
        return r.recordset;
      });
      context.res = {
        status: 200,
        headers: CORS,
        body: JSON.stringify({
          part: String(inspectPart).trim(),
          rowCount: rows.length,
          rows: rows.map(r => ({
            ...r,
            PartNo: (r.PartNo || '').trim(),
            ParsedHts: extractHtsCode(r.Comment),
          })),
        }),
      };
      return;
    }

    const requested = (req.body && Array.isArray(req.body.vendors) && req.body.vendors.length)
      ? req.body.vendors
      : DEFAULT_VENDORS;

    // Normalise and cap — SQL Server allows 2100 parameters per request.
    const vendors = requested
      .map(v => String(v || '').trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 500);

    if (!vendors.length) {
      context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'No vendors supplied.' }) };
      return;
    }

    // The HTS code is read from INMASTX via a correlated scalar subquery rather
    // than a join: INMASTX can hold several rows per part (facility / revision),
    // and a join would duplicate PO lines and double the tariff totals.
    //
    // Keep SQL `--` comments out of the query string below. They have been seen
    // to swallow the following line by the time the statement reaches the
    // server, producing syntax errors at whatever token came next.
    // ?noComment=1 drops the INMASTX subquery, ?debug=1 returns the SQL without
    // running it. Both exist to isolate syntax problems against the live server
    // without a redeploy per attempt.
    const noComment = req.query && (req.query.noComment === '1');
    const debug = req.query && (req.query.debug === '1');

    const rows = await withQuery(connString, async (request) => {
      const vendorParams = vendors.map((v, i) => {
        request.input(`v${i}`, sql.VarChar, v);
        return `@v${i}`;
      }).join(',');

      const statusParams = OPEN_STATUSES.map((s, i) => {
        request.input(`s${i}`, sql.VarChar, s);
        return `@s${i}`;
      }).join(',');


      // Every alias is bracketed. LINENO and DESCRIPTION are reserved words in
      // T-SQL, and an unbracketed `AS LineNo` is a syntax error — which is why
      // the source query bracketed them too.
      const statement = [
        'SELECT',
        '    pm.FPONO AS [PONo],',
        '    pm.FVENDNO AS [VendorNo],',
        '    v.FCOMPANY AS [VendorName],',
        '    v.FCOUNTRY AS [VendorCountry],',
        '    pm.FSTATUS AS [POStatus],',
        '    pi.FITEMNO AS [LineNo],',
        '    pi.FRELSNO AS [Rls],',
        '    pi.FPARTNO AS [PartNo],',
        '    pi.FREV AS [Rev],',
        '    CAST(pi.FDESCRIPT AS VARCHAR(255)) AS [Description],',
        '    pi.FORDQTY AS [QtyOrdered],',
        '    pi.FRCPQTY AS [QtyReceived],',
        '    (pi.FORDQTY - pi.FRCPQTY) AS [QtyOpen],',
        '    pi.FMEASURE AS [UOM],',
        '    pi.FUCOST AS [UnitCost],',
        '    ((pi.FORDQTY - pi.FRCPQTY) * pi.FUCOST) AS [ExtendedCost],',
        '    pi.FLSTPDATE AS [LastPromiseDate],',
        '    pi.FREQDATE AS [RequestDate]',
        'FROM POMAST pm',
        '    INNER JOIN POITEM pi ON pi.FPONO = pm.FPONO',
        '    LEFT JOIN APVEND v ON v.FVENDNO = pm.FVENDNO',
        `WHERE pm.FVENDNO IN (${vendorParams})`,
        '  AND (pi.FORDQTY - pi.FRCPQTY) > 0',
        `  AND pm.FSTATUS IN (${statusParams})`,
        'ORDER BY v.FCOUNTRY, pm.FVENDNO, pm.FPONO, pi.FITEMNO',
      ].join('\n');

      if (debug) {
        const err = new Error('debug');
        err.statement = statement;
        throw err;
      }

      const r = await request.query(statement);
      return r.recordset;
    });

    // INMASTX holds one row per part AND revision, and the HTS code is often on
    // only one of them — a correlated TOP 1 silently returned whichever row the
    // engine felt like, so a code recorded against rev 1 was invisible while
    // rev 0 carried an unrelated note. Fetch every comment for the parts in
    // play and choose in JS, where the choice can be explained.
    const partNos = [...new Set(rows.map(r => String(r.PartNo || '').trim()).filter(Boolean))];

    const comments = new Map();   // partNo -> [{ rev, comment }]
    for (let i = 0; i < partNos.length; i += 400) {
      const slice = partNos.slice(i, i + 400);
      const batch = await withQuery(connString, async (request) => {
        const params = slice.map((pn, j) => {
          request.input(`p${j}`, sql.VarChar, pn);
          return `@p${j}`;
        }).join(',');
        const r = await request.query(`
          SELECT LTRIM(RTRIM(im.FPARTNO)) AS [PartNo],
                 LTRIM(RTRIM(im.FREV))    AS [Rev],
                 CAST(im.FCOMMENT AS VARCHAR(4000)) AS [Comment]
          FROM INMASTX im
          WHERE LTRIM(RTRIM(im.FPARTNO)) IN (${params})
            AND im.FCOMMENT IS NOT NULL
        `);
        return r.recordset;
      });
      for (const c of batch) {
        const key = (c.PartNo || '').trim();
        if (!comments.has(key)) comments.set(key, []);
        comments.set(key, [...comments.get(key), { rev: (c.Rev || '').trim(), comment: c.Comment }]);
      }
    }

    /**
     * The comment for a PO line, preferring the revision actually ordered.
     *
     * Falling back to any revision that yields a code matters: a part can carry
     * the classification on one revision and unrelated notes on another.
     */
    function commentFor(partNo, rev) {
      const list = comments.get(String(partNo || '').trim()) || [];
      if (!list.length) return { comment: null, revUsed: null };

      const exact = list.find(c => c.rev === String(rev || '').trim());
      if (exact && extractHtsCode(exact.comment)) return { comment: exact.comment, revUsed: exact.rev };

      const coded = list.find(c => extractHtsCode(c.comment));
      if (coded) return { comment: coded.comment, revUsed: coded.rev };

      return { comment: exact ? exact.comment : list[0].comment, revUsed: exact ? exact.rev : list[0].rev };
    }

    // M2M pads fixed-width character columns, which would otherwise show up as
    // trailing spaces in every dashboard cell and break exact-match filters.
    const all = rows.map(row => {
      const out = {};
      for (const [k, val] of Object.entries(row)) {
        out[k] = typeof val === 'string' ? val.trim() : val;
      }
      // Fall back to the override only when APVEND genuinely has nothing, and
      // flag it so a figure derived from an assumed origin is traceable.
      if (!out.VendorCountry && VENDOR_COUNTRY_OVERRIDES[out.VendorNo]) {
        out.VendorCountry = VENDOR_COUNTRY_OVERRIDES[out.VendorNo];
        out.VendorCountryAssumed = true;
      }
      const picked = commentFor(out.PartNo, out.Rev);
      out.ItemComment = picked.comment;
      out.ItemCommentRev = picked.revUsed;
      out.HtsCode = extractHtsCode(out.ItemComment);
      // Keep the source text so a wrong or missing code can be traced back to
      // the comment it came from without opening M2M.
      out.ItemComment = out.ItemComment ? String(out.ItemComment).slice(0, 500) : null;
      return out;
    });

    const shaped = all.filter(r => !isNonMaterial(r.PartNo));
    // Name what was dropped rather than just how many, so an over-eager rule
    // is visible instead of quietly shrinking the dashboard.
    const excludedParts = [...new Set(
      all.filter(r => isNonMaterial(r.PartNo)).map(r => String(r.PartNo || '').trim()),
    )].sort();

    const withHts = shaped.filter(r => r.HtsCode).length;

    context.res = {
      status: 200,
      headers: CORS,
      body: JSON.stringify({
        fetchedAt: new Date().toISOString(),
        vendorCount: vendors.length,
        rowCount: shaped.length,
        htsResolved: withHts,
        htsMissing: shaped.length - withHts,
        excludedNonMaterial: all.length - shaped.length,
        excludedParts,
        rows: shaped,
      }),
    };
  } catch (err) {
    if (err && err.statement) {
      context.res = { status: 200, headers: CORS, body: JSON.stringify({ debug: true, statement: err.statement }) };
      return;
    }
    context.log.error('[open-po-overseas] Error:', err);
    context.res = {
      status: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message || String(err) }),
    };
  }
};
