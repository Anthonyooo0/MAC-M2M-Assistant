const sql = require('mssql');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

// Shared connection pool — reused across invocations (big perf win)
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
      connectionTimeout: 15000,
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

    // GET — load all messages for a session
    if (req.method === 'GET') {
      const sessionId = req.query.sessionId;
      if (!sessionId) {
        context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'sessionId required' }) };
        return;
      }
      const result = await pool.request()
        .input('sessionId', sql.UniqueIdentifier, sessionId)
        .query('SELECT id, role, content, sql_query, columns, rows_data, row_count, error, created_at FROM chat_messages WHERE session_id = @sessionId ORDER BY created_at ASC');

      // Parse JSON fields
      const messages = result.recordset.map(row => ({
        id: row.id,
        role: row.role,
        content: row.content,
        sql: row.sql_query || undefined,
        columns: row.columns ? JSON.parse(row.columns) : undefined,
        rows: row.rows_data ? JSON.parse(row.rows_data) : undefined,
        rowCount: row.row_count,
        error: row.error || undefined,
      }));

      context.res = { status: 200, headers: CORS, body: JSON.stringify(messages) };
      return;
    }

    // POST — save a message (or batch of messages)
    if (req.method === 'POST') {
      const { sessionId, messages } = req.body || {};
      if (!sessionId || !Array.isArray(messages) || messages.length === 0) {
        context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'sessionId and messages[] required' }) };
        return;
      }

      for (const msg of messages) {
        await pool.request()
          .input('sessionId', sql.UniqueIdentifier, sessionId)
          .input('role', sql.NVarChar, msg.role)
          .input('content', sql.NVarChar, msg.content || '')
          .input('sqlQuery', sql.NVarChar, msg.sql || null)
          .input('columns', sql.NVarChar, msg.columns ? JSON.stringify(msg.columns) : null)
          .input('rowsData', sql.NVarChar, msg.rows ? JSON.stringify(msg.rows) : null)
          .input('rowCount', sql.Int, msg.rowCount != null ? msg.rowCount : null)
          .input('error', sql.NVarChar, msg.error || null)
          .query(`INSERT INTO chat_messages (session_id, role, content, sql_query, columns, rows_data, row_count, error)
                  VALUES (@sessionId, @role, @content, @sqlQuery, @columns, @rowsData, @rowCount, @error)`);
      }

      // Update session timestamp and auto-title from first user message
      // Also return the new title so frontend can update without re-fetching
      const firstUserMsg = messages.find(m => m.role === 'user');
      let newTitle = null;
      if (firstUserMsg) {
        const autoTitle = firstUserMsg.content.substring(0, 60);
        const updateResult = await pool.request()
          .input('sessionId', sql.UniqueIdentifier, sessionId)
          .input('autoTitle', sql.NVarChar, autoTitle)
          .query(`UPDATE chat_sessions SET
                    updated_at = GETUTCDATE(),
                    title = CASE WHEN title = 'New Chat' THEN @autoTitle ELSE title END
                  WHERE id = @sessionId;
                  SELECT title FROM chat_sessions WHERE id = @sessionId;`);
        if (updateResult.recordset && updateResult.recordset[0]) {
          newTitle = updateResult.recordset[0].title;
        }
      }

      context.res = { status: 201, headers: CORS, body: JSON.stringify({ ok: true, title: newTitle }) };
      return;
    }

    context.res = { status: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    if (err.code === 'ECONNCLOSED' || err.code === 'ENOTOPEN') {
      poolPromise = null;
    }
    context.log.error('[chat-messages] Error:', err);
    context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
