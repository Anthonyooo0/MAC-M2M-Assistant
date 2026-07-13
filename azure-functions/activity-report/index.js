// Activity report — a small, read-only "who's been querying" report for the
// admins and the CEO's designated viewer. It reads ONLY from the app's own
// database (CHAT_DB_CONNECTION: chat_sessions / chat_messages) — it never
// touches the M2M ERP database. Returns the same {columns, rows} shape the
// chat UI already renders, so the frontend can display it like any result.

const sql = require('mssql');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

// Who may view the activity report: the admins + the CEO's viewer.
const ACTIVITY_VIEWERS = [
  'anthony.jimenez@macproducts.net',
  'juan.ortiz@macproducts.net',
  'jerson.fulgencio@macproducts.net',
  'edward.russnow@macproducts.net',
];

// Parse a classic ADO.NET connection string into an mssql config object.
function parseConn(connStr) {
  const p = {};
  for (const seg of connStr.split(';')) {
    const idx = seg.indexOf('=');
    if (idx === -1) continue;
    p[seg.substring(0, idx).trim().toLowerCase()] = seg.substring(idx + 1).trim();
  }
  return {
    server: p['server'] || p['data source'] || '',
    database: p['database'] || p['initial catalog'] || '',
    user: p['user id'] || p['uid'] || '',
    password: p['password'] || p['pwd'] || '',
    options: { encrypt: true, trustServerCertificate: false },
    connectionTimeout: 10000,
    requestTimeout: 20000,
  };
}

module.exports = async function (context, req) {
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

  const viewer = String((req.body && req.body.userEmail) || '').trim().toLowerCase();
  if (!ACTIVITY_VIEWERS.includes(viewer)) {
    context.res = { status: 403, headers: CORS, body: JSON.stringify({ error: 'You are not authorized to view the activity report.' }) };
    return;
  }

  const connStr = process.env.CHAT_DB_CONNECTION;
  if (!connStr) {
    context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: 'Activity log is not configured (CHAT_DB_CONNECTION missing).' }) };
    return;
  }

  let pool = null;
  try {
    pool = new sql.ConnectionPool(parseConn(connStr));
    await pool.connect();

    // The 200 most recent questions people have asked, newest first, with who
    // asked and when. Strip the internal [ADMIN:x] prefix admins get when they
    // post inside another user's chat, so the report reads cleanly.
    const result = await pool.request().query(`
      SELECT TOP 200
        CONVERT(varchar(19), m.created_at, 120) AS [When (UTC)],
        s.user_email                            AS [User],
        CASE WHEN m.content LIKE '[[]ADMIN:%]%'
             THEN SUBSTRING(m.content, CHARINDEX(']', m.content) + 1, 8000)
             ELSE m.content END                 AS [Question]
      FROM chat_messages m
      JOIN chat_sessions s ON m.session_id = s.id
      WHERE m.role = 'user'
      ORDER BY m.created_at DESC`);

    const rows = result.recordset || [];
    const columns = rows.length ? Object.keys(rows[0]) : ['When (UTC)', 'User', 'Question'];

    context.res = {
      status: 200,
      headers: CORS,
      body: JSON.stringify({
        explanation: `Query activity — the ${rows.length} most recent questions across all users (newest first). Source: app database only.`,
        sql: '',
        columns,
        rows,
        rowCount: rows.length,
      }),
    };
  } catch (e) {
    context.log.error('[activity-report] error:', e);
    context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: 'Activity report failed: ' + (e.message || String(e)) }) };
  } finally {
    if (pool) { try { await pool.close(); } catch (_) { /* ignore */ } }
  }
};
