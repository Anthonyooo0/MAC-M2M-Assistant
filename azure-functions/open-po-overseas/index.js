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

// PO header statuses that mean the order is no longer live.
const CLOSED_STATUSES = ['CLOSED', 'CANCELLED', 'COMPLETED', 'COMPLETE', 'VOID'];

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

  const candidates = [];

  // Pass 1: anything following an "HTS" marker — "HTS #", "HTS:", "HTS ".
  // "HST" is accepted too: the transposition occurs in real item comments.
  const marker = /H[TS]S\s*(?:CODE)?\s*[#:]?\s*([0-9][0-9.\s-]*)/gi;
  let m;
  while ((m = marker.exec(text)) !== null) candidates.push(m[1]);

  // Pass 2: a fully-formed dotted code anywhere, for comments with no marker.
  const dotted = /\b(\d{4}\.\d{2}(?:\.\d{2,4})?)\b/g;
  while ((m = dotted.exec(text)) !== null) candidates.push(m[1]);

  let best = null;
  for (const raw of candidates) {
    // Stop at the first whitespace run: "7419.99.5050 0%" -> "7419.99.5050",
    // which is what keeps the trailing duty rate out of the result.
    const head = raw.trim().split(/[\s ]+/)[0];
    const digits = head.replace(/\D/g, '');

    // 6/8/10 digits are the real HTS levels. Anything else is some other number
    // that happened to sit near the marker.
    if (![6, 8, 10].includes(digits.length)) continue;

    // Chapter 99 headings are surcharges (Section 301/232 etc.), not
    // classifications. Comments often list them beside the real code —
    // returning one as the part's HTS code would be wrong.
    if (digits.startsWith('9903')) continue;

    const formatted =
      digits.length === 10 ? `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}`
      : digits.length === 8 ? `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}`
      : `${digits.slice(0, 4)}.${digits.slice(4)}`;

    // Prefer the most specific code when a comment mentions several.
    if (!best || digits.length > best.digits) best = { formatted, digits: digits.length };
  }

  return best ? best.formatted : null;
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

      const statusParams = CLOSED_STATUSES.map((s, i) => {
        request.input(`s${i}`, sql.VarChar, s);
        return `@s${i}`;
      }).join(',');

      const commentSelect = noComment
        ? `NULL AS [ItemComment]`
        : `(SELECT TOP 1 CAST(im.FCOMMENT AS VARCHAR(4000)) FROM INMASTX im WHERE im.FPARTNO = pi.FPARTNO AND im.FCOMMENT IS NOT NULL) AS [ItemComment]`;

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
        '    pi.FREQDATE AS [RequestDate],',
        `    ${commentSelect}`,
        'FROM POMAST pm',
        '    INNER JOIN POITEM pi ON pi.FPONO = pm.FPONO',
        '    LEFT JOIN APVEND v ON v.FVENDNO = pm.FVENDNO',
        `WHERE pm.FVENDNO IN (${vendorParams})`,
        '  AND (pi.FORDQTY - pi.FRCPQTY) > 0',
        `  AND pm.FSTATUS NOT IN (${statusParams})`,
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

    // M2M pads fixed-width character columns, which would otherwise show up as
    // trailing spaces in every dashboard cell and break exact-match filters.
    const shaped = rows.map(row => {
      const out = {};
      for (const [k, val] of Object.entries(row)) {
        out[k] = typeof val === 'string' ? val.trim() : val;
      }
      out.HtsCode = extractHtsCode(out.ItemComment);
      // Keep the source text so a wrong or missing code can be traced back to
      // the comment it came from without opening M2M.
      out.ItemComment = out.ItemComment ? String(out.ItemComment).slice(0, 500) : null;
      return out;
    });

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
