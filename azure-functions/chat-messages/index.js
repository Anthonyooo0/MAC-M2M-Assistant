const sql = require('mssql');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
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

    // GET — load all messages for a session
    if (req.method === 'GET') {
      const sessionId = req.query.sessionId;
      if (!sessionId) {
        context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'sessionId required' }) };
        return;
      }
      const result = await pool.request()
        .input('sessionId', sql.UniqueIdentifier, sessionId)
        .query('SELECT id, role, content, sql_query, columns, column_sources, rows_data, row_count, error, created_at FROM chat_messages WHERE session_id = @sessionId ORDER BY created_at ASC');

      // Get per-query costs for this session
      let costMap = {};
      try {
        const costResult = await pool.request()
          .input('costSessionId', sql.UniqueIdentifier, sessionId)
          .query('SELECT input_tokens, output_tokens, gemini_calls, cost, created_at FROM query_costs WHERE session_id = @costSessionId ORDER BY created_at ASC');
        // Build array of costs to match with assistant messages in order
        const costs = costResult.recordset;
        let costIdx = 0;
        // We'll assign costs to assistant messages with SQL in order
        result.recordset.forEach(row => {
          if (row.role === 'assistant' && row.sql_query && costIdx < costs.length) {
            costMap[row.id] = {
              inputTokens: costs[costIdx].input_tokens,
              outputTokens: costs[costIdx].output_tokens,
              calls: costs[costIdx].gemini_calls,
              cost: costs[costIdx].cost,
            };
            costIdx++;
          }
        });
      } catch (costErr) {
        // Cost data not available — continue without it
      }

      // Parse JSON fields and extract admin tags
      const messages = result.recordset.map(row => {
        let content = row.content || '';
        let adminSender = undefined;
        const adminMatch = content.match(/^\[ADMIN:([^\]]+)\]\s*/);
        if (adminMatch) {
          adminSender = adminMatch[1];
          content = content.replace(adminMatch[0], '');
        }
        return {
          id: row.id,
          role: row.role,
          content,
          sql: row.sql_query || undefined,
          columns: row.columns ? JSON.parse(row.columns) : undefined,
          columnSources: row.column_sources ? JSON.parse(row.column_sources) : undefined,
          rows: row.rows_data ? JSON.parse(row.rows_data) : undefined,
          rowCount: row.row_count,
          error: row.error || undefined,
          adminSender,
          cost: costMap[row.id] || undefined,
        };
      });

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
          .input('columnSources', sql.NVarChar, msg.columnSources ? JSON.stringify(msg.columnSources) : null)
          .input('rowsData', sql.NVarChar, msg.rows ? JSON.stringify(msg.rows) : null)
          .input('rowCount', sql.Int, msg.rowCount != null ? msg.rowCount : null)
          .input('error', sql.NVarChar, msg.error || null)
          .query(`INSERT INTO chat_messages (session_id, role, content, sql_query, columns, column_sources, rows_data, row_count, error)
                  VALUES (@sessionId, @role, @content, @sqlQuery, @columns, @columnSources, @rowsData, @rowCount, @error)`);
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

    // PUT — submit feedback on a message (thumbs up/down)
    if (req.method === 'PUT') {
      const { messageId, feedback } = req.body || {};
      if (!messageId || !feedback || !['good', 'bad'].includes(feedback)) {
        context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'messageId and feedback ("good" or "bad") required' }) };
        return;
      }
      await pool.request()
        .input('id', sql.UniqueIdentifier, messageId)
        .input('feedback', sql.NVarChar, feedback)
        .query('UPDATE chat_messages SET feedback = @feedback WHERE id = @id');
      context.res = { status: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
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
