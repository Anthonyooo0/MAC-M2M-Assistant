const sql = require('mssql');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Load the full M2M schema at startup
const schemaPath = path.join(__dirname, '..', 'm2m-schema.txt');
let M2M_SCHEMA = '';
try {
  M2M_SCHEMA = fs.readFileSync(schemaPath, 'utf-8');
} catch (e) {
  console.error('Could not load m2m-schema.txt:', e.message);
}

const SYSTEM_PROMPT = `You are an AI assistant for MAC Products employees that helps them query the M2M ERP database (Made2Manage version 7.51).

You MUST respond with valid JSON in this exact format:
{"explanation":"A helpful plain-English explanation of what the data shows, any insights, and answers to the user's question. Be conversational and helpful. If the user asked a question, answer it directly.","sql":"THE SQL QUERY HERE"}

If the user asks a general question that does NOT need a database query (like 'what am I looking at', 'explain this', 'what does this field mean', etc.), respond with:
{"explanation":"Your helpful answer here","sql":""}

=== RESTRICTED TABLES — NEVER QUERY THESE ===
The following tables contain sensitive/personal information and must NEVER be queried, referenced, or included in any SQL:
- PREMPL (Employee Master — SSN, DOB, salary, home address, emergency contacts)
- PRDIST (GL Postings from Payroll — employee payroll amounts)
- LADETAIL (Daily Labor Detail — employee earnings, overtime rates)
- LADETAILVIEW (Daily Labor Detail View)
- LAMAST (Daily Labor Master — employee work records)
- CRHEAD (Cash Flow/Payroll Header — wages, salary, fringe benefits)
- CSPAYR (Payroll System Setup — payroll config, earnings codes)
- UTUSER (User Master — passwords, login credentials)
- UTPASSWD (Change Password — stored passwords)
- APCHAC (AP Checking Accounts — bank account numbers, routing numbers)
- APEFTMAST (AP EFT Batch Master — bank account IDs)
- VENDEFT (Vendor EFT Bank Detail — vendor bank accounts, routing numbers)
If a user asks for data from ANY of these tables, politely explain that the table contains restricted information (employee personal data, payroll, credentials, or banking details) and cannot be queried.

=== ABSOLUTE RULE — SCHEMA IS YOUR ONLY SOURCE OF TRUTH ===
The COMPLETE database schema is provided below. It lists every table (## TABLENAME) and every column under each table.
- You may ONLY use table names and column names that are EXPLICITLY listed in the schema below.
- Do NOT guess, infer, or assume ANY column name exists. If a column is not listed directly under a table heading, it DOES NOT EXIST.
- Do NOT use column names you know from general M2M/ERP knowledge. This database may differ from standard M2M.
- Do NOT use column names mentioned inside the DESCRIPTION text of other columns. Descriptions are informational only — they do not define columns on the current table.
- If you cannot find the right column for what the user wants, DO NOT write SQL. Instead, set sql to "" and in your explanation list the available columns for that table and ask the user which one to use.
- NEVER fabricate a column name. When in doubt, don't query — explain what's available instead.

QUERY RULES:
1. ONLY generate SELECT queries. Never INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, EXEC, EXECUTE, TRUNCATE.
2. Always use TOP 500 to limit results unless the user asks for a count/aggregate.
3. ALWAYS use column aliases (AS) to give every column a clean, human-readable name. Users do not know internal field names like FSONO or FCOMPANY. Use the description from the schema as a guide.
   Examples: RTRIM(FSONO) AS "Sales Order", RTRIM(FCOMPANY) AS "Company", FORDERQTY AS "Order Qty", FORDDATE AS "Order Date"
   - Every column in every SELECT must have an AS alias with a friendly name.
   - Use double quotes around aliases that contain spaces.
   - For aggregates: COUNT(*) AS "Total Count", SUM(FORDERQTY) AS "Total Qty"
4. M2M uses fixed-width CHAR fields — always use RTRIM() when displaying or comparing text values.
4. Use proper JOIN syntax when linking tables.
5. When searching text, use LIKE with wildcards: WHERE RTRIM(fcompany) LIKE '%search%'
6. Dates of 1899-12-31 or 1900-01-01 mean "not set" — filter these out when showing dates.
7. Common table relationships:
   - SOMAST.fsono = SOITEM.fsono (Sales Order -> Line Items)
   - SOMAST.fsono = JOMAST.fsono (Sales Order -> Job Orders)
   - JOMAST.fjobno = JODRTG.fjobno (Job Order -> Routing Steps)
   - JOMAST.fjobno = JODBOM.fjobno (Job Order -> Bill of Materials)
   - POITEM.fpono = POMAST.fpono (PO Items -> PO Master)
   - POITEM.fsokey = SOMAST.fsono (PO Items -> Sales Order)
   - INMAST.fpartno = part number lookups across all tables
   - ARCUST.fcustno = customer lookups
8. Key column corrections (common mistakes to avoid):
   - SOITEM: use FQUANTITY (not fshipqty). SOMAST: use FSTATUS for status.
   - POMAST/POITEM: there is NO FDUEDATE. Use POMAST.FORDDATE (order date), POMAST.FREQDATE (request date), POITEM.FREQDATE (date requested), POITEM.FORGPDATE (original promise date), POITEM.FLSTPDATE (last promise date).

IMPORTANT: Your response must be ONLY the JSON object. No markdown, no code blocks, no extra text. Just the JSON.

Here is the COMPLETE M2M database schema with all tables and fields:

${M2M_SCHEMA}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callGeminiAPI(geminiUrl, geminiBody) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(geminiBody);
    const urlObj = new URL(geminiUrl);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          parsed._statusCode = res.statusCode;
          resolve(parsed);
        } catch (e) {
          reject(new Error('Failed to parse Gemini response: ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function parseGeminiResponse(geminiData) {
  const generatedText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!generatedText) throw new Error('Gemini returned no response.');

  let aiResponse;
  try {
    let cleaned = generatedText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    aiResponse = JSON.parse(cleaned);
  } catch (e) {
    // Fallback: treat entire response as SQL (backward compat)
    aiResponse = {
      explanation: '',
      sql: generatedText
        .replace(/^```sql\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim(),
    };
  }

  return {
    explanation: aiResponse.explanation || '',
    sqlQuery: (aiResponse.sql || '').trim(),
  };
}

function cleanSqlQuery(sqlQuery) {
  // Strip SQL comments
  let cleaned = sqlQuery
    .replace(/^\s*--[^\n]*\n/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();

  // If it doesn't start with SELECT/WITH, try to extract the SELECT statement from it
  const firstWord = (cleaned.split(/\s+/)[0] || '').toUpperCase();
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    // Try to find a SELECT or WITH statement embedded in the response
    const selectMatch = cleaned.match(/\b(SELECT\s[\s\S]+)/i) || cleaned.match(/\b(WITH\s[\s\S]+)/i);
    if (selectMatch) {
      cleaned = selectMatch[1].trim();
    }
  }
  return cleaned;
}

function validateSqlSafety(sqlQuery) {
  const firstWord = (sqlQuery.split(/\s+/)[0] || '').toUpperCase();

  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    return { ok: false, reason: 'Only SELECT queries are allowed.' };
  }
  const RESTRICTED_TABLES = ['PREMPL','PRDIST','LADETAIL','LADETAILVIEW','LAMAST','CRHEAD','CSPAYR','UTUSER','UTPASSWD','APCHAC','APEFTMAST','VENDEFT'];
  for (const table of RESTRICTED_TABLES) {
    if (new RegExp('\\b' + table + '\\b', 'i').test(sqlQuery)) {
      return { ok: false, reason: `This query references a restricted table (${table}) containing sensitive information.` };
    }
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXEC|EXECUTE|TRUNCATE|MERGE|GRANT|REVOKE)\b/i.test(sqlQuery)) {
    return { ok: false, reason: 'Query contains forbidden keywords.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Main Azure Function
// ---------------------------------------------------------------------------

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
    const { message, history } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'message is required' }) };
      return;
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: 'Gemini API key is not configured.' }) };
      return;
    }

    // Pick connection string based on requested database
    const { database } = req.body || {};
    let connString;
    if (database === 'm2mdata66') {
      connString = process.env.M2M_IMPULSE_CONNECTION_STRING;
      if (!connString) {
        context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: 'MAC Impulse database connection is not configured.' }) };
        return;
      }
    } else {
      // DEBUG: Log the raw env var to see what Azure is giving us
      const rawEnv = process.env.M2M_CONNECTION_STRING;
      context.log.info(`[m2m-query] RAW M2M_CONNECTION_STRING = "${rawEnv}"`);
      connString = rawEnv;
      if (!connString) {
        context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: 'M2M database connection is not configured.' }) };
        return;
      }
    }

    // Build conversation for Gemini
    const geminiMessages = [];

    if (Array.isArray(history)) {
      for (const turn of history) {
        if (turn.role === 'user') {
          geminiMessages.push({ role: 'user', parts: [{ text: turn.content }] });
        } else if (turn.role === 'model') {
          geminiMessages.push({ role: 'model', parts: [{ text: turn.content }] });
        }
      }
    }

    geminiMessages.push({ role: 'user', parts: [{ text: message.trim() }] });

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${geminiKey}`;

    // -----------------------------------------------------------------------
    // First Gemini call
    // -----------------------------------------------------------------------
    const geminiBody = {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: geminiMessages,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
    };

    const geminiData = await callGeminiAPI(geminiUrl, geminiBody);

    if (geminiData._statusCode && geminiData._statusCode >= 400) {
      context.log.error('[m2m-query] Gemini error:', JSON.stringify(geminiData));
      context.res = {
        status: 500,
        headers: CORS,
        body: JSON.stringify({ error: 'Gemini API error: ' + (geminiData.error?.message || JSON.stringify(geminiData)) }),
      };
      return;
    }

    if (!geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()) {
      context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: 'Gemini returned no response.' }) };
      return;
    }

    let { explanation, sqlQuery } = parseGeminiResponse(geminiData);

    // Clean SQL: strip comments, extract SELECT if wrapped in other statements
    if (sqlQuery) {
      sqlQuery = cleanSqlQuery(sqlQuery);
    }

    // If no SQL query, just return the explanation (conversational response)
    if (!sqlQuery) {
      context.res = {
        status: 200,
        headers: CORS,
        body: JSON.stringify({ explanation, sql: '', columns: [], rows: [], rowCount: 0 }),
      };
      return;
    }

    // Safety checks
    const safety = validateSqlSafety(sqlQuery);
    if (!safety.ok) {
      context.res = {
        status: 400,
        headers: CORS,
        body: JSON.stringify({ error: safety.reason, explanation, sql: sqlQuery }),
      };
      return;
    }

    // Parse M2M connection string
    const parts = {};
    for (const segment of connString.split(';')) {
      const idx = segment.indexOf('=');
      if (idx === -1) continue;
      const key = segment.substring(0, idx).trim().toLowerCase();
      const val = segment.substring(idx + 1).trim();
      parts[key] = val;
    }

    const config = {
      server: parts['server'] || parts['data source'] || '',
      database: parts['database'] || parts['initial catalog'] || '',
      user: parts['user id'] || parts['uid'] || '',
      password: parts['password'] || parts['pwd'] || '',
      options: { encrypt: false, trustServerCertificate: true },
      connectionTimeout: 15000,
      requestTimeout: 30000,
    };

    pool = await sql.connect(config);

    // -----------------------------------------------------------------------
    // Execute SQL — with one silent retry on invalid column name errors
    // -----------------------------------------------------------------------
    let result;
    try {
      result = await pool.request().query(sqlQuery);
    } catch (sqlErr) {
      // Detect SQL Server "Invalid column name 'X'" or "Invalid object name 'X'" hallucinations
      const invalidColMatch = sqlErr.message && sqlErr.message.match(/Invalid column name '([^']+)'/i);
      const invalidObjMatch = sqlErr.message && sqlErr.message.match(/Invalid object name '([^']+)'/i);

      if (!invalidColMatch && !invalidObjMatch) {
        // Not a column/table error — surface it normally
        throw sqlErr;
      }

      const badName = invalidColMatch ? invalidColMatch[1] : invalidObjMatch[1];
      const errorType = invalidColMatch ? 'column' : 'table';
      context.log.warn(`[m2m-query] Invalid ${errorType} '${badName}' — retrying with correction context`);

      const correctionText = invalidColMatch
        ? `The SQL query you just generated failed with this database error: ` +
          `"Invalid column name '${badName}'". ` +
          `The column '${badName}' does not exist in the database schema. ` +
          `Please search the schema carefully for the correct column name in the relevant table(s) ` +
          `and generate a corrected SQL query using only column names that are explicitly listed in the schema. ` +
          `Do not guess or infer any column names.`
        : `The SQL query you just generated failed with this database error: ` +
          `"Invalid object name '${badName}'". ` +
          `The table '${badName}' does not exist in the database. ` +
          `Please search the schema carefully for the correct table name and ` +
          `generate a corrected SQL query using only table names that are explicitly listed in the schema. ` +
          `Do not guess or infer any table names.`;

      // Build retry conversation: feed the failed attempt back as context
      const retryMessages = [
        ...geminiMessages,
        // What the model previously produced (the bad SQL)
        { role: 'model', parts: [{ text: JSON.stringify({ explanation, sql: sqlQuery }) }] },
        // Correction from the "user" (automated, never shown to the human user)
        {
          role: 'user',
          parts: [{ text: correctionText }],
        },
      ];

      const retryGeminiBody = {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: retryMessages,
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      };

      const retryGeminiData = await callGeminiAPI(geminiUrl, retryGeminiBody);

      if (retryGeminiData._statusCode && retryGeminiData._statusCode >= 400) {
        context.log.error('[m2m-query] Gemini retry error:', JSON.stringify(retryGeminiData));
        throw sqlErr; // Fall back to original error
      }

      if (!retryGeminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()) {
        throw sqlErr;
      }

      const retryParsed = parseGeminiResponse(retryGeminiData);
      explanation = retryParsed.explanation;
      let retrySqlQuery = retryParsed.sqlQuery;
      if (retrySqlQuery) retrySqlQuery = cleanSqlQuery(retrySqlQuery);

      if (!retrySqlQuery) {
        // Model responded with explanation-only on retry — return it
        context.res = {
          status: 200,
          headers: CORS,
          body: JSON.stringify({ explanation, sql: '', columns: [], rows: [], rowCount: 0 }),
        };
        return;
      }

      const retrySafety = validateSqlSafety(retrySqlQuery);
      if (!retrySafety.ok) {
        throw sqlErr; // Unexpected — fall back to original error
      }

      context.log.info(`[m2m-query] Retry SQL: ${retrySqlQuery}`);
      result = await pool.request().query(retrySqlQuery);
      sqlQuery = retrySqlQuery; // use the corrected SQL in the response
    }

    const columns = result.recordset.length > 0 ? Object.keys(result.recordset[0]) : [];

    context.res = {
      status: 200,
      headers: CORS,
      body: JSON.stringify({
        explanation,
        sql: sqlQuery,
        columns,
        rows: result.recordset,
        rowCount: result.recordset.length,
      }),
    };

  } catch (err) {
    context.log.error('[m2m-query] Error:', err);
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
