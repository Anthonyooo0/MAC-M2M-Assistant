const sql = require('mssql');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    const connString = process.env.CHAT_DB_CONNECTION;
    if (!connString) throw new Error('CHAT_DB_CONNECTION not configured');
    const parts = {};
    for (const segment of connString.split(';')) {
      const idx = segment.indexOf('=');
      if (idx === -1) continue;
      parts[segment.substring(0, idx).trim().toLowerCase()] = segment.substring(idx + 1).trim();
    }
    const config = {
      server: parts['server'] || parts['data source'] || '',
      database: parts['database'] || parts['initial catalog'] || '',
      user: parts['user id'] || parts['uid'] || '',
      password: parts['password'] || parts['pwd'] || '',
      options: { encrypt: true, trustServerCertificate: false },
      // 60s: an Azure SQL serverless database resuming from auto-pause takes
      // ~30-60s. A shorter timeout can never wait one out, so the first request
      // after an idle period always failed. Better a slow load than an error.
      connectionTimeout: 60000,
      requestTimeout: 30000,
      pool: { max: 10, min: 1, idleTimeoutMillis: 30000 },
    };
    const pool = new sql.ConnectionPool(config);
    poolPromise = pool.connect().catch(err => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

module.exports = async function (context, req) {
  if (req.method === 'OPTIONS') {
    context.res = { status: 200, headers: CORS };
    return;
  }

  try {
    const pool = await getPool();
    const type = req.query.type || 'summary';

    // GET ?type=summary — totals for today, this week, this month
    if (type === 'summary') {
      const result = await pool.request().query(`
        SELECT
          SUM(CASE WHEN created_at >= CAST(GETUTCDATE() AS DATE) THEN cost ELSE 0 END) AS today_cost,
          SUM(CASE WHEN created_at >= CAST(GETUTCDATE() AS DATE) THEN gemini_calls ELSE 0 END) AS today_calls,
          SUM(CASE WHEN created_at >= CAST(GETUTCDATE() AS DATE) THEN 1 ELSE 0 END) AS today_queries,
          SUM(CASE WHEN created_at >= DATEADD(day, -7, GETUTCDATE()) THEN cost ELSE 0 END) AS week_cost,
          SUM(CASE WHEN created_at >= DATEADD(day, -7, GETUTCDATE()) THEN gemini_calls ELSE 0 END) AS week_calls,
          SUM(CASE WHEN created_at >= DATEADD(day, -7, GETUTCDATE()) THEN 1 ELSE 0 END) AS week_queries,
          SUM(CASE WHEN created_at >= DATEADD(month, DATEDIFF(month, 0, GETUTCDATE()), 0) THEN cost ELSE 0 END) AS month_cost,
          SUM(CASE WHEN created_at >= DATEADD(month, DATEDIFF(month, 0, GETUTCDATE()), 0) THEN gemini_calls ELSE 0 END) AS month_calls,
          SUM(CASE WHEN created_at >= DATEADD(month, DATEDIFF(month, 0, GETUTCDATE()), 0) THEN 1 ELSE 0 END) AS month_queries,
          SUM(cost) AS total_cost,
          SUM(gemini_calls) AS total_calls,
          COUNT(*) AS total_queries
        FROM query_costs
      `);

      context.res = { status: 200, headers: CORS, body: JSON.stringify(result.recordset[0]) };
      return;
    }

    // GET ?type=by-user — cost breakdown by user (this month)
    if (type === 'by-user') {
      const result = await pool.request().query(`
        SELECT
          user_email AS "user",
          COUNT(*) AS queries,
          SUM(gemini_calls) AS calls,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cost) AS cost
        FROM query_costs
        WHERE created_at >= DATEADD(month, DATEDIFF(month, 0, GETUTCDATE()), 0)
        GROUP BY user_email
        ORDER BY SUM(cost) DESC
      `);

      context.res = { status: 200, headers: CORS, body: JSON.stringify(result.recordset) };
      return;
    }

    // GET ?type=by-session — cost per session
    if (type === 'by-session') {
      const result = await pool.request().query(`
        SELECT
          qc.session_id,
          cs.title AS session_title,
          cs.user_email,
          COUNT(*) AS queries,
          SUM(qc.gemini_calls) AS calls,
          SUM(qc.cost) AS cost,
          MIN(qc.created_at) AS first_query,
          MAX(qc.created_at) AS last_query
        FROM query_costs qc
        LEFT JOIN chat_sessions cs ON qc.session_id = cs.id
        WHERE qc.created_at >= DATEADD(month, DATEDIFF(month, 0, GETUTCDATE()), 0)
        GROUP BY qc.session_id, cs.title, cs.user_email
        ORDER BY SUM(qc.cost) DESC
      `);

      context.res = { status: 200, headers: CORS, body: JSON.stringify(result.recordset) };
      return;
    }

    // GET ?type=by-day — daily cost for the last 30 days
    if (type === 'by-day') {
      const result = await pool.request().query(`
        SELECT
          CAST(created_at AS DATE) AS date,
          COUNT(*) AS queries,
          SUM(gemini_calls) AS calls,
          SUM(cost) AS cost
        FROM query_costs
        WHERE created_at >= DATEADD(day, -30, GETUTCDATE())
        GROUP BY CAST(created_at AS DATE)
        ORDER BY CAST(created_at AS DATE) DESC
      `);

      context.res = { status: 200, headers: CORS, body: JSON.stringify(result.recordset) };
      return;
    }

    context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid type. Use: summary, by-user, by-session, by-day' }) };
  } catch (err) {
    if (err.code === 'ECONNCLOSED' || err.code === 'ENOTOPEN') {
      poolPromise = null;
    }
    context.log.error('[query-costs] Error:', err);
    context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
