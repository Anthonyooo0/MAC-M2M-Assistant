const sql = require('mssql');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

function getDbConfig() {
  const connString = process.env.CHAT_DB_CONNECTION_STRING;
  if (!connString) throw new Error('CHAT_DB_CONNECTION_STRING not configured');
  const parts = {};
  for (const segment of connString.split(';')) {
    const idx = segment.indexOf('=');
    if (idx === -1) continue;
    parts[segment.substring(0, idx).trim().toLowerCase()] = segment.substring(idx + 1).trim();
  }
  return {
    server: parts['server'] || parts['data source'] || '',
    database: parts['database'] || parts['initial catalog'] || '',
    user: parts['user id'] || parts['uid'] || '',
    password: parts['password'] || parts['pwd'] || '',
    options: { encrypt: true, trustServerCertificate: false },
    connectionTimeout: 15000,
    requestTimeout: 30000,
  };
}

module.exports = async function (context, req) {
  if (req.method === 'OPTIONS') {
    context.res = { status: 200, headers: CORS };
    return;
  }

  let pool = null;
  try {
    pool = await sql.connect(getDbConfig());

    // GET — list sessions for a user (or all users if admin=true)
    if (req.method === 'GET') {
      const userEmail = (req.query.userEmail || '').trim().toLowerCase();
      const isAdmin = req.query.admin === 'true';

      if (!userEmail) {
        context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'userEmail required' }) };
        return;
      }

      // Admin mode: return all sessions grouped by user
      if (isAdmin) {
        const ADMINS = (process.env.CHAT_ADMINS || '').toLowerCase().split(',').map(e => e.trim()).filter(Boolean);
        if (!ADMINS.includes(userEmail)) {
          context.res = { status: 403, headers: CORS, body: JSON.stringify({ error: 'Not authorized as admin' }) };
          return;
        }
        const result = await pool.request()
          .query('SELECT id, user_email, title, created_at, updated_at FROM chat_sessions ORDER BY updated_at DESC');
        context.res = { status: 200, headers: CORS, body: JSON.stringify(result.recordset) };
        return;
      }

      const result = await pool.request()
        .input('userEmail', sql.NVarChar, userEmail)
        .query('SELECT id, title, created_at, updated_at FROM chat_sessions WHERE user_email = @userEmail ORDER BY updated_at DESC');
      context.res = { status: 200, headers: CORS, body: JSON.stringify(result.recordset) };
      return;
    }

    // POST — create new session
    if (req.method === 'POST') {
      const { userEmail, title } = req.body || {};
      if (!userEmail) {
        context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'userEmail required' }) };
        return;
      }
      const result = await pool.request()
        .input('userEmail', sql.NVarChar, userEmail.trim().toLowerCase())
        .input('title', sql.NVarChar, (title || 'New Chat').substring(0, 255))
        .query('INSERT INTO chat_sessions (user_email, title) OUTPUT INSERTED.id, INSERTED.title, INSERTED.created_at, INSERTED.updated_at VALUES (@userEmail, @title)');
      context.res = { status: 201, headers: CORS, body: JSON.stringify(result.recordset[0]) };
      return;
    }

    // PUT — rename session
    if (req.method === 'PUT') {
      const { sessionId, title } = req.body || {};
      if (!sessionId || !title) {
        context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'sessionId and title required' }) };
        return;
      }
      await pool.request()
        .input('id', sql.UniqueIdentifier, sessionId)
        .input('title', sql.NVarChar, title.substring(0, 255))
        .query('UPDATE chat_sessions SET title = @title, updated_at = GETUTCDATE() WHERE id = @id');
      context.res = { status: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      return;
    }

    // DELETE — delete session (cascade deletes messages)
    if (req.method === 'DELETE') {
      const sessionId = req.query.sessionId || (req.body || {}).sessionId;
      if (!sessionId) {
        context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'sessionId required' }) };
        return;
      }
      await pool.request()
        .input('id', sql.UniqueIdentifier, sessionId)
        .query('DELETE FROM chat_sessions WHERE id = @id');
      context.res = { status: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
      return;
    }

    context.res = { status: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    context.log.error('[chat-sessions] Error:', err);
    context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  } finally {
    if (pool) try { await pool.close(); } catch { }
  }
};
