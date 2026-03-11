const sql = require('mssql');

module.exports = async function (context, req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    context.res = {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    };
    return;
  }

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  let pool = null;

  try {
    const { so_number } = req.body || {};

    if (!so_number || typeof so_number !== 'string' || !so_number.trim()) {
      context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'so_number is required' }) };
      return;
    }

    const connString = process.env.M2M_CONNECTION_STRING;
    if (!connString) {
      context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: 'M2M database connection is not configured.' }) };
      return;
    }

    // Parse connection string
    const parts = {};
    for (const segment of connString.split(';')) {
      const idx = segment.indexOf('=');
      if (idx === -1) continue;
      const key = segment.substring(0, idx).trim().toLowerCase();
      const val = segment.substring(idx + 1).trim();
      parts[key] = val;
    }

    const server = parts['server'] || parts['data source'] || '';
    const database = parts['database'] || parts['initial catalog'] || '';
    const user = parts['user id'] || parts['uid'] || '';
    const password = parts['password'] || parts['pwd'] || '';

    const isDomain = user.includes('\\');
    const config = {
      server,
      database,
      options: {
        encrypt: false,
        trustServerCertificate: true,
      },
      connectionTimeout: 15000,
      requestTimeout: 30000,
    };

    if (isDomain) {
      const [domain, username] = user.split('\\');
      config.user = username;
      config.password = password;
      config.domain = domain;
    } else {
      config.user = user;
      config.password = password;
    }

    pool = await sql.connect(config);

    const soNum = so_number.trim();

    // 1. Sales Order Header from SOMAST
    const soHeaderResult = await pool.request()
      .input('sono', sql.VarChar, soNum)
      .query(`
        SELECT fsono, fcompany, fstatus, fordername, fcustpono, forderdate, fduedate,
               festimator, fsocoord, fsoldby, fshipvia, fclos_dt
        FROM SOMAST
        WHERE fsono = @sono
      `);

    if (soHeaderResult.recordset.length === 0) {
      context.res = { status: 404, headers: CORS, body: JSON.stringify({ error: 'No sales order found for SO number: ' + soNum }) };
      return;
    }

    const soHeader = soHeaderResult.recordset[0];

    // 2. Sales Order Line Items from SOITEM
    const lineItemsResult = await pool.request()
      .input('sono', sql.VarChar, soNum)
      .query(`
        SELECT finumber, fenumber, fpartno, fpartrev, fquantity, fmeasure,
               fsource, fduedate, fcitemstatus, fprodcl
        FROM SOITEM
        WHERE fsono = @sono
        ORDER BY finumber
      `);

    // Get descriptions for line items (fdesc is a memo field, try to get it)
    const lineItemDescs = await pool.request()
      .input('sono', sql.VarChar, soNum)
      .query(`
        SELECT finumber, fdesc
        FROM SOITEM
        WHERE fsono = @sono
        ORDER BY finumber
      `);

    // Merge descriptions into line items
    const descMap = {};
    for (const row of lineItemDescs.recordset) {
      descMap[row.finumber] = row.fdesc;
    }

    const lineItems = lineItemsResult.recordset.map(item => ({
      ...item,
      fdesc: descMap[item.finumber] || '',
    }));

    // 3. All Job Orders linked to this Sales Order from JOMAST
    const jobsResult = await pool.request()
      .input('sono', sql.VarChar, soNum)
      .query(`
        SELECT fjobno, fstatus, fpartno, fdescript, fquantity, fddue_date, frel_dt
        FROM JOMAST
        WHERE fsono = @sono
        ORDER BY fjobno
      `);

    // 4. Routing steps for all linked jobs
    const jobs = jobsResult.recordset;
    const routingByJob = {};

    for (const job of jobs) {
      const jobNo = job.fjobno.trim();
      const routingResult = await pool.request()
        .input('jonum', sql.VarChar, jobNo)
        .query(`
          SELECT foperno, fpro_id, fnpct_comp, fcomp_date
          FROM JODRTG
          WHERE fjobno = @jonum
          ORDER BY foperno
        `);
      routingByJob[jobNo] = routingResult.recordset;
    }

    // 5. Purchase Orders linked to this SO or its jobs
    const poResult = await pool.request()
      .input('sono', sql.VarChar, soNum)
      .query(`
        SELECT
          pi.fpono,
          pm.fcompany AS fvendor_name,
          pi.fpartno,
          pi.fordqty,
          pi.frcpqty,
          pi.flstpdate,
          pi.fjokey,
          pi.fsokey
        FROM POITEM pi
        INNER JOIN POMAST pm ON pi.fpono = pm.fpono
        WHERE pi.fsokey = @sono
        ORDER BY pi.fpono
      `);

    const response = {
      soHeader,
      lineItems,
      jobs: jobs.map(job => ({
        ...job,
        routing: routingByJob[job.fjobno.trim()] || [],
      })),
      purchaseOrders: poResult.recordset,
    };

    context.res = { status: 200, headers: CORS, body: JSON.stringify(response) };

  } catch (err) {
    context.log.error('[m2m-status] Error:', err);
    context.res = {
      status: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message || String(err) }),
    };
  } finally {
    if (pool) {
      try { await pool.close(); } catch { /* ignore */ }
    }
  }
};
