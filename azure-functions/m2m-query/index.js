const sql = require('mssql');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Load schemas at startup
const m2mSchemaPath = path.join(__dirname, '..', 'm2m-schema-slim.txt');
let M2M_SCHEMA = '';
try {
  M2M_SCHEMA = fs.readFileSync(m2mSchemaPath, 'utf-8');
} catch (e) {
  console.error('Could not load m2m-schema-slim.txt:', e.message);
}

const uniSchemaPath = path.join(__dirname, '..', 'unipoint-schema-slim.txt');
let UNIPOINT_SCHEMA = '';
try {
  UNIPOINT_SCHEMA = fs.readFileSync(uniSchemaPath, 'utf-8');
} catch (e) {
  console.error('Could not load unipoint-schema-slim.txt:', e.message);
}

const SYSTEM_PROMPT = `You are an AI assistant for MAC Products employees that helps them query the M2M ERP database (Made2Manage version 7.51).
Your SQL queries ARE executed automatically against the live database and results are shown to the user. You are NOT just generating SQL for the user to copy — the system runs your queries and displays results. Never tell users to copy SQL or run it themselves.

You MUST respond with valid JSON in this exact format:
{"explanation":"A helpful plain-English explanation of what the data shows, any insights, and answers to the user's question. Be conversational and helpful. If the user asked a question, answer it directly.","sql":"THE SQL QUERY HERE"}

If the user asks a general question that does NOT need a database query (like 'what am I looking at', 'explain this', 'what does this field mean', etc.), respond with:
{"explanation":"Your helpful answer here","sql":""}

=== RESTRICTED TABLES — NEVER QUERY THESE ===
The following tables contain sensitive information and must NEVER be queried, referenced, or included in any SQL:

HR, Payroll & Labor (PII):
- PREMPL (Employee Master — SSN, DOB, salary, home address, emergency contacts)
- CSPAYR (Payroll System Setup — payroll config, overtime rates, earning codes)
- PRDIST (Payroll Distribution — employee payroll amounts)
- PRDEPT (Payroll Departments — departmental labor distributions)
- CRHEAD (CRP Header — average hourly wages, fringes, compensation)
- CRMAST (CRP Master — employee compensation/benefit projections)
- LADETAIL (Daily Labor Detail — employee earnings, pay rates)
- LADETAILVIEW (Daily Labor Detail View)
- LAMAST (Daily Labor Master — timecard entries)

Banking & EFT (PCI/Financial):
- APCHAC (AP Checking Accounts — bank account numbers, routing numbers)
- APEFTMAST (AP EFT Batch Master — bank account IDs)
- VENDEFT (Vendor EFT Bank Detail — vendor bank accounts, routing numbers)
- CCINFO (Credit Card Information — customer credit card numbers)
- CCSETUPMAST (Credit Card Setup — payment gateway account IDs, passwords)

System Security:
- UTUSER (User Master — user accounts, privileges, encrypted passwords)
- UTPASSWD (Change Password Log — password history)
- UTPREF (System Wide Settings — admin usernames, global passwords)

Corporate Financials:
- GLMAST (GL Chart of Accounts)
- GLITEM (GL Account Balances)
- GLSTMT (Bank Reconciliation Statement)
- PLBUDG (Budgets per GL Account)

If a user asks for data from ANY of these tables, politely explain that the table contains restricted information and cannot be queried.

=== RESTRICTED COLUMNS — NEVER SELECT THESE FIELDS ===
Even on tables that ARE allowed, NEVER include these columns in any query:
- INMASTX: F2LABCOST, F2MATLCOST, F2OVHDCOST, FAVGCOST (internal cost data)
- INPROD: FCOGSLAB, FCOGSMATL, FCOGSOVHD (COGS breakdowns)
- SOANAL: FNGRSPFT01 through FNGRSPFT12 (gross profit by period)
- JOPACT: FLABACT, FMATLACT, FOTHRACT (actual job costs)
- BLQOC / BLQOP: FNBLPROFIT, FNQUPROFIT (backlog/quote profit)
If a user asks for cost, margin, or profit data from these fields, explain that internal cost/profit data is restricted.

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

const UNIPOINT_SYSTEM_PROMPT = `You are an AI assistant for MAC Products quality team members that helps them query the UniPoint Quality Management database.
Your SQL queries ARE executed automatically against the live database and results are shown to the user. You are NOT just generating SQL for the user to copy — the system runs your queries and displays results. Never tell users to copy SQL or run it themselves.

You MUST respond with valid JSON in this exact format:
{"explanation":"A helpful plain-English explanation of what the data shows, any insights, and answers to the user's question. Be conversational and helpful. If the user asked a question, answer it directly.","sql":"THE SQL QUERY HERE"}

If the user asks a general question that does NOT need a database query (like 'what am I looking at', 'explain this', 'what does this field mean', etc.), respond with:
{"explanation":"Your helpful answer here","sql":""}

=== RESTRICTED TABLES — NEVER QUERY THESE ===
- PT_Security_Users (user accounts, passwords)
- PT_Employee (SSN, pay rates, personal data)
- PT_Employee_Extended (passwords, login credentials)
- PT_Cashflow and all PT_Cashflow_* tables (financial data)
- PT_GST (tax configuration)
If a user asks for data from these tables, politely explain that they contain restricted information.

=== ABSOLUTE RULE — SCHEMA IS YOUR ONLY SOURCE OF TRUTH ===
The COMPLETE database schema is provided below. It lists every table (## TABLENAME) and every column under each table.
- You may ONLY use table names and column names that are EXPLICITLY listed in the schema below.
- Do NOT guess, infer, or assume ANY column name exists. If a column is not listed under a table heading, it DOES NOT EXIST.
- Do NOT use column names from general UniPoint knowledge. This database may differ.
- Do NOT invent column names like "NC_Date", "Orig_Date", "Date_Reported", "Total_Cost", "Cause_Code", "Cause", "NC_No" — these do NOT exist.
- If you cannot find the right column, set sql to "" and in your explanation list the ACTUAL available columns for that table so the user can pick one.
- NEVER fabricate a column name. When in doubt, don't query — explain what's available instead.

=== KEY COLUMN CORRECTIONS (common mistakes to avoid) ===
- PT_NC: The date column is NCR_Date (NOT NC_Date, NOT Orig_Date, NOT Date_Reported). The cost column is NC_processing_cost (NOT Total_Cost). The ID column is NCR (NOT NC_No, NOT NC_Number). The cause/reason column is Origin_cause (NOT Cause_Code, NOT Cause). The category column is Origin_category.
- PT_CPA: The ID is CPA_no (NOT CPA_No with capital N, NOT CPA_Number). The date is CPA_date.
- PT_Inspection: The ID is Inspection_No. The date is InspectionDate.
- PT_Equip: The ID is Equip_num. The description is Equip_Desc.
- PT_Equip_Maint: The ID is Maint_num. The date is Create_date.

QUERY RULES:
1. ONLY generate SELECT queries. Never INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, EXEC, EXECUTE, TRUNCATE.
2. Always use TOP 500 to limit results unless the user asks for a count/aggregate.
3. ALWAYS use column aliases (AS) to give every column a clean, human-readable name.
   Examples: NCR AS "NCR Number", Status AS "Status", NCR_Date AS "Date Reported"
   - Every column in every SELECT must have an AS alias with a friendly name.
   - Use double quotes around aliases that contain spaces.
4. UniPoint uses nvarchar fields — no need for RTRIM().
5. Use proper JOIN syntax when linking tables.
6. Common table relationships:
   - PT_Inspection.InspectionSpecification_No = PT_InspectionSpecification.InspectionSpecification_No
   - PT_Inspection.Inspection_No = PT_InspectionItem.Inspection_No
   - PT_InspectionItem.Inspection_No = PT_InspectionItem_Measurement.Inspection_No
   - PT_InspectionItem.InspectionItemID = PT_InspectionItem_Measurement.InspectionItemID
   - PT_InspectionSpecification_Measurement.InspectionSpecification_No = PT_InspectionSpecification.InspectionSpecification_No
   - PT_NC.CPA_No = PT_CPA.CPA_no (Non-Conformance → Corrective Action)
   - PT_NC.Vendor links to vendor lookups
   - PT_NC.Customer links to customer lookups
   - PT_Equip_Maint.Equip_num = PT_Equip.Equip_num
   - PT_Attach links to various records via AttachType/AttachReference
   - PT_SignOff links via SignoffType/SignoffTypeID
   - PT_History tracks changes via ObjectType/ObjectKey

IMPORTANT: Your response must be ONLY the JSON object. No markdown, no code blocks, no extra text. Just the JSON.

Here is the COMPLETE UniPoint database schema with all tables and fields:

${UNIPOINT_SCHEMA}
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
  const RESTRICTED_TABLES = [
    // HR, Payroll & Labor
    'PREMPL','CSPAYR','PRDIST','PRDEPT','CRHEAD','CRMAST','LADETAIL','LADETAILVIEW','LAMAST',
    // Banking & EFT
    'APCHAC','APEFTMAST','VENDEFT','CCINFO','CCSETUPMAST',
    // System Security
    'UTUSER','UTPASSWD','UTPREF',
    // Corporate Financials
    'GLMAST','GLITEM','GLSTMT','PLBUDG',
  ];
  for (const table of RESTRICTED_TABLES) {
    if (new RegExp('\\b' + table + '\\b', 'i').test(sqlQuery)) {
      return { ok: false, reason: `This query references a restricted table (${table}) containing sensitive information.` };
    }
  }
  const RESTRICTED_COLUMNS = [
    'F2LABCOST','F2MATLCOST','F2OVHDCOST','FAVGCOST',   // INMASTX costs
    'FCOGSLAB','FCOGSMATL','FCOGSOVHD',                  // INPROD COGS
    'FNGRSPFT01','FNGRSPFT02','FNGRSPFT03','FNGRSPFT04', // SOANAL gross profit
    'FNGRSPFT05','FNGRSPFT06','FNGRSPFT07','FNGRSPFT08',
    'FNGRSPFT09','FNGRSPFT10','FNGRSPFT11','FNGRSPFT12',
    'FLABACT','FMATLACT','FOTHRACT',                      // JOPACT actual costs
    'FNBLPROFIT','FNQUPROFIT',                             // BLQOC/BLQOP profit
  ];
  for (const col of RESTRICTED_COLUMNS) {
    if (new RegExp('\\b' + col + '\\b', 'i').test(sqlQuery)) {
      return { ok: false, reason: `This query references a restricted column (${col}) containing confidential cost/profit data.` };
    }
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXEC|EXECUTE|TRUNCATE|MERGE|GRANT|REVOKE)\b/i.test(sqlQuery)) {
    return { ok: false, reason: 'Query contains forbidden keywords.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// UniPoint schema validator — checks SQL against actual schema before execution
// ---------------------------------------------------------------------------

function parseSchemaFile(schemaText) {
  const tables = {};
  let currentTable = null;
  for (const line of schemaText.split('\n')) {
    const tableMatch = line.match(/^## (\S+)/);
    if (tableMatch) {
      currentTable = tableMatch[1].toLowerCase();
      tables[currentTable] = new Set();
    } else if (currentTable) {
      const colMatch = line.match(/^\s+(\S+)\s+\(/);
      if (colMatch) {
        tables[currentTable].add(colMatch[1].toLowerCase());
      }
    }
  }
  return tables;
}

// Parse once at startup
const UNIPOINT_TABLES = parseSchemaFile(UNIPOINT_SCHEMA);

function validateAgainstSchema(sqlQuery, schemaTables) {
  const errors = [];

  // Extract table names after FROM and JOIN (case-insensitive)
  const tablePattern = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let match;
  const usedTables = new Set();
  while ((match = tablePattern.exec(sqlQuery)) !== null) {
    const tableName = match[1].toLowerCase();
    // Skip subquery aliases and common SQL keywords
    if (['select', 'where', 'on', 'and', 'or', 'not', 'in', 'as', 'top'].includes(tableName)) continue;
    usedTables.add(tableName);
    if (!schemaTables[tableName]) {
      errors.push(`Table '${match[1]}' does not exist in the schema. Available tables: ${Object.keys(schemaTables).slice(0, 15).join(', ')}...`);
    }
  }

  // Extract column references — look for word.word patterns (table.column) and bare columns
  // Only validate table.column patterns since bare column names could be aliases
  const qualifiedColPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
  while ((match = qualifiedColPattern.exec(sqlQuery)) !== null) {
    const tableName = match[1].toLowerCase();
    const colName = match[2].toLowerCase();
    // Skip if it's an alias or not a known table
    if (!schemaTables[tableName]) continue;
    if (!schemaTables[tableName].has(colName)) {
      // Find similar columns to suggest
      const available = [...schemaTables[tableName]];
      const similar = available.filter(c => c.includes(colName) || colName.includes(c)).slice(0, 5);
      const suggestion = similar.length > 0 ? ` Similar columns: ${similar.join(', ')}` : ` Available columns: ${available.slice(0, 10).join(', ')}...`;
      errors.push(`Column '${match[2]}' does not exist in table '${match[1]}'.${suggestion}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
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
  let sqlQuery = '';
  let explanation = '';
  let dbServer = '?';
  let dbName = '?';

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

    // Pick connection string and system prompt based on requested database
    const { database } = req.body || {};
    let connString;
    let activePrompt = SYSTEM_PROMPT;
    if (database === 'm2mdata66') {
      connString = process.env.M2M_IMPULSE_CONNECTION_STRING;
      if (!connString) {
        context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: 'MAC Impulse database connection is not configured.' }) };
        return;
      }
    } else if (database === 'unipoint_live') {
      connString = process.env.UNIPOINT_CONNECTION_STRING;
      activePrompt = UNIPOINT_SYSTEM_PROMPT;
      if (!connString) {
        context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: 'UniPoint database connection is not configured.' }) };
        return;
      }
    } else {
      connString = process.env.M2M_CONNECTION_STRING;
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

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent?key=${geminiKey}`;

    // -----------------------------------------------------------------------
    // First Gemini call
    // -----------------------------------------------------------------------
    const geminiBody = {
      system_instruction: { parts: [{ text: activePrompt }] },
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

    ({ explanation, sqlQuery } = parseGeminiResponse(geminiData));

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

    // Safety checks — retry once if Gemini generated non-SELECT SQL
    let safety = validateSqlSafety(sqlQuery);
    if (!safety.ok) {
      context.log.warn(`[m2m-query] Safety check failed: ${safety.reason} — retrying`);

      const safetyRetryMessages = [
        ...geminiMessages,
        { role: 'model', parts: [{ text: JSON.stringify({ explanation, sql: sqlQuery }) }] },
        {
          role: 'user',
          parts: [{
            text: `Your query was rejected: "${safety.reason}". ` +
              `You MUST only generate SELECT queries. Do not use INSERT, UPDATE, DELETE, DROP, or any other statement type. ` +
              `Please regenerate as a SELECT query only.`,
          }],
        },
      ];

      const safetyRetryBody = {
        system_instruction: { parts: [{ text: activePrompt }] },
        contents: safetyRetryMessages,
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      };

      const safetyRetryData = await callGeminiAPI(geminiUrl, safetyRetryBody);
      if (safetyRetryData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()) {
        const retryParsed = parseGeminiResponse(safetyRetryData);
        explanation = retryParsed.explanation;
        let retrySql = retryParsed.sqlQuery;
        if (retrySql) retrySql = cleanSqlQuery(retrySql);

        if (retrySql) {
          sqlQuery = retrySql;
          safety = validateSqlSafety(sqlQuery);
        }
      }

      if (!safety.ok) {
        context.res = {
          status: 400,
          headers: CORS,
          body: JSON.stringify({ error: safety.reason, explanation, sql: sqlQuery }),
        };
        return;
      }
    }

    // UniPoint only: validate SQL against schema before executing
    if (database === 'unipoint_live' && sqlQuery) {
      const schemaCheck = validateAgainstSchema(sqlQuery, UNIPOINT_TABLES);
      if (!schemaCheck.ok) {
        context.log.warn(`[m2m-query] Schema validation failed: ${schemaCheck.errors.join('; ')} — retrying`);

        const schemaRetryMessages = [
          ...geminiMessages,
          { role: 'model', parts: [{ text: JSON.stringify({ explanation, sql: sqlQuery }) }] },
          {
            role: 'user',
            parts: [{
              text: `Your SQL query failed schema validation before execution. The following problems were found:\n` +
                schemaCheck.errors.map(e => `- ${e}`).join('\n') + '\n\n' +
                `You MUST only use table and column names from the schema. Please fix these errors and regenerate the query.`,
            }],
          },
        ];

        const schemaRetryBody = {
          system_instruction: { parts: [{ text: activePrompt }] },
          contents: schemaRetryMessages,
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
        };

        const schemaRetryData = await callGeminiAPI(geminiUrl, schemaRetryBody);
        if (schemaRetryData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()) {
          const retryParsed = parseGeminiResponse(schemaRetryData);
          explanation = retryParsed.explanation;
          let retrySql = retryParsed.sqlQuery;
          if (retrySql) retrySql = cleanSqlQuery(retrySql);

          if (retrySql) {
            const retrySchemaCheck = validateAgainstSchema(retrySql, UNIPOINT_TABLES);
            if (retrySchemaCheck.ok) {
              sqlQuery = retrySql;
            } else {
              // Still invalid after retry — return the errors to user
              context.res = {
                status: 400,
                headers: CORS,
                body: JSON.stringify({
                  error: `Schema validation failed: ${retrySchemaCheck.errors.join('; ')}`,
                  explanation,
                  sql: retrySql,
                }),
              };
              return;
            }
          }
        }
      }
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

    const config = {
      server: parts['server'] || parts['data source'] || '',
      database: parts['database'] || parts['initial catalog'] || '',
      user: parts['user id'] || parts['uid'] || '',
      password: parts['password'] || parts['pwd'] || '',
      options: { encrypt: false, trustServerCertificate: true },
      connectionTimeout: 15000,
      requestTimeout: 30000,
    };

    dbServer = config.server;
    dbName = config.database;
    context.log.info(`[m2m-query] Connecting to server="${dbServer}" database="${dbName}" user="${config.user}"`);

    pool = new sql.ConnectionPool(config);
    await pool.connect();

    // -----------------------------------------------------------------------
    // Execute SQL — with up to 2 retries on any SQL error
    // -----------------------------------------------------------------------
    const MAX_RETRIES = 2;
    let result;
    let lastError = null;
    let retryConversation = [...geminiMessages];

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        result = await pool.request().query(sqlQuery);
        lastError = null;
        break; // Success — exit the retry loop
      } catch (sqlErr) {
        lastError = sqlErr;

        if (attempt >= MAX_RETRIES) {
          // Out of retries — will throw below
          break;
        }

        context.log.warn(`[m2m-query] SQL error (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — retrying: ${sqlErr.message}`);

        // Build error-specific correction guidance
        let fixGuidance = '';
        const errMsg = sqlErr.message || '';
        if (/Incorrect syntax near/i.test(errMsg)) {
          const near = errMsg.match(/near '([^']+)'/i);
          fixGuidance = `This is a SQL SYNTAX error near '${near ? near[1] : '?'}'. Common causes:\n` +
            `- Missing comma between columns in SELECT\n` +
            `- Unmatched parentheses in function calls like DATEADD()\n` +
            `- Backslash \\ characters (SQL Server does not use backslash escaping)\n` +
            `- Missing space between keywords\n` +
            `Rewrite the query from scratch with correct syntax.`;
        } else if (/Invalid column name/i.test(errMsg)) {
          const col = errMsg.match(/Invalid column name '([^']+)'/i);
          fixGuidance = `The column '${col ? col[1] : '?'}' does NOT exist. ` +
            `Search the schema for the correct column name. Do NOT guess — use only columns explicitly listed under the table heading.`;
        } else if (/Invalid object name/i.test(errMsg)) {
          const obj = errMsg.match(/Invalid object name '([^']+)'/i);
          fixGuidance = `The table '${obj ? obj[1] : '?'}' does NOT exist. ` +
            `Check the schema for the correct table name.`;
        } else if (/Ambiguous column name/i.test(errMsg)) {
          const col = errMsg.match(/Ambiguous column name '([^']+)'/i);
          fixGuidance = `The column '${col ? col[1] : '?'}' exists in multiple tables in your JOIN. ` +
            `Prefix it with the table name, e.g., TableName.${col ? col[1] : 'ColumnName'}.`;
        } else if (/conversion failed/i.test(errMsg)) {
          fixGuidance = `There is a data type conversion error. Check that you are comparing the right types ` +
            `(e.g., don't compare a date to a number, use proper date formats like '2025-01-01').`;
        } else {
          fixGuidance = `Check the schema carefully and make sure every table name, column name, and SQL syntax is correct.`;
        }

        retryConversation = [
          ...retryConversation,
          { role: 'model', parts: [{ text: JSON.stringify({ explanation, sql: sqlQuery }) }] },
          {
            role: 'user',
            parts: [{
              text: `The SQL query you generated failed with this database error:\n` +
                `"${errMsg}"\n\n` +
                `The failed query was:\n${sqlQuery}\n\n` +
                `${fixGuidance}\n\n` +
                `Generate a corrected query using ONLY columns from the schema.`,
            }],
          },
        ];

        const retryGeminiBody = {
          system_instruction: { parts: [{ text: activePrompt }] },
          contents: retryConversation,
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
        };

        const retryGeminiData = await callGeminiAPI(geminiUrl, retryGeminiBody);

        if (retryGeminiData._statusCode && retryGeminiData._statusCode >= 400) {
          context.log.error('[m2m-query] Gemini retry error:', JSON.stringify(retryGeminiData));
          break;
        }

        if (!retryGeminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()) {
          break;
        }

        const retryParsed = parseGeminiResponse(retryGeminiData);
        explanation = retryParsed.explanation;
        let retrySqlQuery = retryParsed.sqlQuery;
        if (retrySqlQuery) retrySqlQuery = cleanSqlQuery(retrySqlQuery);

        if (!retrySqlQuery) {
          // Model gave explanation-only — return it
          context.res = {
            status: 200,
            headers: CORS,
            body: JSON.stringify({ explanation, sql: '', columns: [], rows: [], rowCount: 0 }),
          };
          return;
        }

        const retrySafety = validateSqlSafety(retrySqlQuery);
        if (!retrySafety.ok) break;

        context.log.info(`[m2m-query] Retry ${attempt + 1} SQL: ${retrySqlQuery}`);
        sqlQuery = retrySqlQuery;
      }
    }

    if (lastError) {
      throw lastError;
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
      body: JSON.stringify({ error: err.message || String(err), sql: sqlQuery || '' }),
    };
  } finally {
    if (pool) {
      try { await pool.close(); } catch { /* ignore */ }
    }
  }
};
