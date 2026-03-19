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

// ---------------------------------------------------------------------------
// Security Configuration — RBAC, Table & Field Restrictions
// ---------------------------------------------------------------------------

// Tables that are completely blocked — no queries allowed
const RESTRICTED_TABLES = [
  // HR, Payroll & Labor (PII)
  'PREMPL',       // Employee Master — SSN, DOB, salary, home address, emergency contacts
  'PRDIST',       // GL Postings from Payroll — employee payroll amounts
  'PRDEPT',       // Payroll Departments — payroll labor distributions
  'LADETAIL',     // Daily Labor Detail — employee earnings, overtime rates
  'LADETAILVIEW', // Daily Labor Detail View
  'LAMAST',       // Daily Labor Master — employee work records
  'CRHEAD',       // Cash Flow/Payroll Header — wages, salary, fringe benefits
  'CRMAST',       // CRP Line Item Master — avg hourly wages, compensation projections
  'CSPAYR',       // Payroll System Setup — payroll config, earnings codes
  // Banking, Credit Card & EFT (PCI-DSS)
  'APCHAC',       // AP Checking Accounts — bank account numbers, routing numbers
  'APEFTMAST',    // AP EFT Batch Master — bank account IDs
  'VENDEFT',      // Vendor EFT Bank Detail — vendor bank accounts, routing numbers
  'CCINFO',       // Credit Card Information — customer card numbers
  'CCSETUPMAST',  // Credit Card Setup — payment gateway account IDs & passwords
  // System Security & Passwords
  'UTUSER',       // User Master — passwords, login credentials
  'UTPASSWD',     // Change Password — stored passwords
  'UTPREF',       // System Wide Settings — domain names, admin passwords
  // Corporate Financials & GL
  'GLMAST',       // GL Chart of Accounts
  'GLITEM',       // GL Account Balances
  'GLSTMT',       // Bank Reconciliation Statement
  'PLBUDG',       // Budgets per GL Account
];

// Fields that are blocked on otherwise-accessible tables (profit margins, COGS, internal costs)
const RESTRICTED_FIELDS = {
  BLQOC:   ['FNBLPROFIT', 'FNQUPROFIT'],
  BLQOP:   ['FNBLPROFIT', 'FNQUPROFIT'],
  INPROD:  ['FCOGSLAB', 'FCOGSMATL', 'FCOGSOVHD'],
  INMASTX: ['F2LABCOST', 'F2MATLCOST', 'F2OVHDCOST', 'FAVGCOST', 'F2DISPLCST', 'F2DISPMCST', 'F2DISPOCST', 'F2DISPTCST', 'F2TOTCOST'],
  SOANAL:  ['FNGRSPFT01','FNGRSPFT02','FNGRSPFT03','FNGRSPFT04','FNGRSPFT05','FNGRSPFT06',
            'FNGRSPFT07','FNGRSPFT08','FNGRSPFT09','FNGRSPFT10','FNGRSPFT11','FNGRSPFT12'],
  JOPACT:  ['FLABACT', 'FMATLACT', 'FOTHRACT', 'FOVHDACT', 'FLABINV', 'FMATLINV', 'FOTHRINV', 'FOVHDINV',
            'FSUBACT', 'FSUBINV', 'FTOOLACT', 'FRTGSETUPA', 'FSETUPACT',
            'FADDEDOCOS', 'FADDEDPCOS', 'FADDEDSCOS'],
};

// Role definitions for future RBAC expansion
const ROLES = {
  admin:       { restrictedTables: [], restrictedFields: {} },                          // Full access
  order_clerk: { restrictedTables: RESTRICTED_TABLES, restrictedFields: RESTRICTED_FIELDS }, // Default
};

// For now, all users get 'order_clerk' restrictions. Expand this mapping as needed.
function getUserRole(/* userEmail */) {
  return 'order_clerk';
}

function getRestrictionsForRole(role) {
  return ROLES[role] || ROLES.order_clerk;
}

// Build the restricted-fields section for the AI system prompt
function buildFieldRestrictionsPrompt(restrictedFields) {
  if (!restrictedFields || Object.keys(restrictedFields).length === 0) return '';
  let lines = [
    '',
    '=== RESTRICTED FIELDS — NEVER SELECT THESE COLUMNS ===',
    'The following columns exist in the schema but contain confidential cost/profit data. NEVER include them in SELECT, WHERE, ORDER BY, or any part of a query.',
    'If a user asks for data that would require these columns, explain that the information is restricted.',
    '',
  ];
  for (const [table, fields] of Object.entries(restrictedFields)) {
    lines.push(`- ${table}: ${fields.join(', ')}`);
  }
  return lines.join('\n');
}

// Filter the schema to remove restricted tables and redact restricted fields
function filterSchema(schema, restrictions) {
  const lines = schema.split('\n');
  const output = [];
  let skipTable = false;
  let currentTable = null;

  for (const line of lines) {
    const tableMatch = line.match(/^## (\w+)/);
    if (tableMatch) {
      const tableName = tableMatch[1].toUpperCase();
      if (restrictions.restrictedTables.includes(tableName)) {
        skipTable = true;
        continue;
      }
      skipTable = false;
      currentTable = tableName;
      output.push(line);
      continue;
    }

    if (skipTable) continue;

    // Check if this line defines a restricted field
    if (currentTable && restrictions.restrictedFields[currentTable]) {
      const fieldMatch = line.match(/^\s+(\w+)\s+\(/);
      if (fieldMatch) {
        const fieldName = fieldMatch[1].toUpperCase();
        if (restrictions.restrictedFields[currentTable].includes(fieldName)) {
          continue; // Redact this field from the schema
        }
      }
    }

    output.push(line);
  }
  return output.join('\n');
}

const SYSTEM_PROMPT_TEMPLATE = (restrictedTablesBlock, restrictedFieldsBlock, filteredSchema) => `You are an AI assistant for MAC Products employees that helps them query the M2M ERP database (Made2Manage version 7.51).

You MUST respond with valid JSON in this exact format:
{"explanation":"A helpful plain-English explanation of what the data shows, any insights, and answers to the user's question. Be conversational and helpful. If the user asked a question, answer it directly.","sql":"THE SQL QUERY HERE"}

If the user asks a general question that does NOT need a database query (like 'what am I looking at', 'explain this', 'what does this field mean', etc.), respond with:
{"explanation":"Your helpful answer here","sql":""}

=== RESTRICTED TABLES — NEVER QUERY THESE ===
The following tables contain sensitive/personal information and must NEVER be queried, referenced, or included in any SQL:
${restrictedTablesBlock}
If a user asks for data from ANY of these tables, politely explain that the table contains restricted information (employee personal data, payroll, credentials, banking, or corporate financials) and cannot be queried.
${restrictedFieldsBlock}

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

${filteredSchema}
`;

// Build the default system prompt (order_clerk role)
function buildSystemPrompt(role) {
  const restrictions = getRestrictionsForRole(role);
  const tablesBlock = restrictions.restrictedTables
    .map(t => `- ${t}`)
    .join('\n');
  const fieldsBlock = buildFieldRestrictionsPrompt(restrictions.restrictedFields);
  const filteredSchema = filterSchema(M2M_SCHEMA, restrictions);
  return SYSTEM_PROMPT_TEMPLATE(tablesBlock, fieldsBlock, filteredSchema);
}

// ---------------------------------------------------------------------------
// Parsed schema lookup — built once at startup for fast validation
// ---------------------------------------------------------------------------

// Parse m2m-schema.txt into { TABLE: { columns: Set([COL1, COL2, ...]), raw: "full text block" } }
function parseSchemaLookup(schema) {
  const lookup = {};
  let currentTable = null;
  let currentRaw = '';
  const lines = schema.split('\n');

  for (const line of lines) {
    const tableMatch = line.match(/^## (\w+)/);
    if (tableMatch) {
      // Save previous table
      if (currentTable) {
        lookup[currentTable].raw = currentRaw.trim();
      }
      currentTable = tableMatch[1].toUpperCase();
      lookup[currentTable] = { columns: new Set(), raw: '' };
      currentRaw = line + '\n';
      continue;
    }
    if (currentTable) {
      currentRaw += line + '\n';
      const fieldMatch = line.match(/^\s+(\w+)\s+\(/);
      if (fieldMatch) {
        lookup[currentTable].columns.add(fieldMatch[1].toUpperCase());
      }
    }
  }
  // Save last table
  if (currentTable && lookup[currentTable]) {
    lookup[currentTable].raw = currentRaw.trim();
  }
  return lookup;
}

const SCHEMA_LOOKUP = parseSchemaLookup(M2M_SCHEMA);

// Extract table names referenced in SQL (FROM, JOIN, and CTE table refs)
function extractTablesFromSql(sqlQuery) {
  const tables = new Set();
  // Match FROM/JOIN <table> patterns (with optional alias)
  const tablePattern = /\b(?:FROM|JOIN)\s+(\w+)/gi;
  let match;
  while ((match = tablePattern.exec(sqlQuery)) !== null) {
    tables.add(match[1].toUpperCase());
  }
  return [...tables];
}

// Extract column names referenced in SQL for a given set of known tables
function extractColumnsFromSql(sqlQuery) {
  const columns = new Set();
  // Match word.word patterns (table.column) and bare column names in SELECT/WHERE/ORDER BY
  // Table-qualified: table.column
  const qualifiedPattern = /\b(\w+)\.(\w+)\b/gi;
  let match;
  while ((match = qualifiedPattern.exec(sqlQuery)) !== null) {
    columns.add({ table: match[1].toUpperCase(), column: match[2].toUpperCase() });
  }
  return [...columns];
}

// Validate all tables and columns in the SQL exist in the schema
function validateSchemaCompliance(sqlQuery, schemaLookup, restrictions) {
  const errors = [];

  // Check tables
  const tables = extractTablesFromSql(sqlQuery);
  const invalidTables = tables.filter(t => !schemaLookup[t]);
  for (const t of invalidTables) {
    // Find closest match for helpful error
    const candidates = Object.keys(schemaLookup)
      .filter(k => k.includes(t) || t.includes(k) || levenshteinClose(t, k))
      .slice(0, 3);
    const suggestion = candidates.length > 0 ? ` Did you mean: ${candidates.join(', ')}?` : '';
    errors.push({ type: 'table', name: t, message: `Table '${t}' does not exist in the schema.${suggestion}` });
  }

  // Check table-qualified columns
  const qualifiedCols = extractColumnsFromSql(sqlQuery);
  for (const { table, column } of qualifiedCols) {
    if (!schemaLookup[table]) continue; // Table error already caught
    // Skip common SQL keywords that look like columns
    if (['AS', 'ON', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'BY', 'ASC', 'DESC', 'TOP', 'LIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'RTRIM', 'LTRIM', 'UPPER', 'LOWER', 'CAST', 'CONVERT', 'ISNULL', 'COALESCE', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'WHERE', 'SELECT', 'FROM', 'JOIN', 'GROUP', 'ORDER', 'HAVING', 'DISTINCT', 'UNION', 'ALL', 'EXISTS'].includes(column)) continue;
    if (!schemaLookup[table].columns.has(column)) {
      const availableCols = [...schemaLookup[table].columns].slice(0, 10).join(', ');
      errors.push({ type: 'column', name: `${table}.${column}`, message: `Column '${column}' does not exist on table '${table}'. Available columns include: ${availableCols}...` });
    }
  }

  return errors;
}

// Simple check if two strings are within edit distance ~2
function levenshteinClose(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  let diff = 0;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) diff++;
    if (diff > 2) return false;
  }
  return true;
}

// Get the raw schema text for specific tables (for focused retries)
function getSchemaForTables(tableNames, schemaLookup) {
  return tableNames
    .filter(t => schemaLookup[t])
    .map(t => schemaLookup[t].raw)
    .join('\n\n');
}

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

function validateSqlSafety(sqlQuery, restrictions) {
  const firstWord = (sqlQuery.split(/\s+/)[0] || '').toUpperCase();

  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    return { ok: false, reason: 'Only SELECT queries are allowed.' };
  }

  // Check restricted tables
  const tables = restrictions ? restrictions.restrictedTables : RESTRICTED_TABLES;
  for (const table of tables) {
    if (new RegExp('\\b' + table + '\\b', 'i').test(sqlQuery)) {
      return { ok: false, reason: `This query references a restricted table (${table}) containing sensitive information.` };
    }
  }

  // Check restricted fields
  const fields = restrictions ? restrictions.restrictedFields : RESTRICTED_FIELDS;
  for (const [table, fieldList] of Object.entries(fields)) {
    for (const field of fieldList) {
      if (new RegExp('\\b' + field + '\\b', 'i').test(sqlQuery)) {
        return { ok: false, reason: `This query references a restricted field (${field} on ${table}) containing confidential cost/profit data.` };
      }
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

    // Determine user role and build role-specific prompt + restrictions
    const userEmail = (req.body.userEmail || '').toLowerCase();
    const role = getUserRole(userEmail);
    const restrictions = getRestrictionsForRole(role);
    const SYSTEM_PROMPT = buildSystemPrompt(role);

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
    const safety = validateSqlSafety(sqlQuery, restrictions);
    if (!safety.ok) {
      context.res = {
        status: 400,
        headers: CORS,
        body: JSON.stringify({ error: safety.reason, explanation, sql: sqlQuery }),
      };
      return;
    }

    // -----------------------------------------------------------------------
    // Pre-execution schema validation — catch hallucinated tables/columns
    // BEFORE they hit SQL Server. If invalid, retry with focused schema.
    // -----------------------------------------------------------------------
    const MAX_RETRIES = 2;
    let currentSql = sqlQuery;
    let currentExplanation = explanation;
    let retryCount = 0;
    let schemaErrors = validateSchemaCompliance(currentSql, SCHEMA_LOOKUP, restrictions);

    while (schemaErrors.length > 0 && retryCount < MAX_RETRIES) {
      retryCount++;
      context.log.warn(`[m2m-query] Schema validation failed (attempt ${retryCount}): ${schemaErrors.map(e => e.message).join('; ')}`);

      // Get the tables referenced in the SQL (valid ones) + nearby suggestions
      const referencedTables = extractTablesFromSql(currentSql);
      const validTables = referencedTables.filter(t => SCHEMA_LOOKUP[t]);
      // Also add suggested tables from error messages
      for (const err of schemaErrors) {
        if (err.type === 'table') {
          const candidates = Object.keys(SCHEMA_LOOKUP)
            .filter(k => k.includes(err.name) || err.name.includes(k) || levenshteinClose(err.name, k));
          validTables.push(...candidates);
        }
      }
      const uniqueTables = [...new Set(validTables)];
      const focusedSchema = getSchemaForTables(uniqueTables, SCHEMA_LOOKUP);

      const errorDetails = schemaErrors.map(e => `- ${e.message}`).join('\n');

      const retryMessages = [
        ...geminiMessages,
        { role: 'model', parts: [{ text: JSON.stringify({ explanation: currentExplanation, sql: currentSql }) }] },
        {
          role: 'user',
          parts: [{
            text:
              `Your SQL query has errors — these tables or columns do NOT exist in the database:\n${errorDetails}\n\n` +
              `Here is the EXACT schema for the relevant tables. Use ONLY these table and column names:\n\n${focusedSchema}\n\n` +
              `Generate a corrected SQL query using ONLY the tables and columns listed above. Do not guess or infer any names.`,
          }],
        },
      ];

      const retryGeminiBody = {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: retryMessages,
        generationConfig: { temperature: 0.0, maxOutputTokens: 2048 },
      };

      const retryGeminiData = await callGeminiAPI(geminiUrl, retryGeminiBody);

      if (retryGeminiData._statusCode && retryGeminiData._statusCode >= 400) {
        context.log.error('[m2m-query] Gemini retry error:', JSON.stringify(retryGeminiData));
        break;
      }
      if (!retryGeminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()) break;

      const retryParsed = parseGeminiResponse(retryGeminiData);
      currentExplanation = retryParsed.explanation;
      let retrySql = retryParsed.sqlQuery;
      if (retrySql) retrySql = cleanSqlQuery(retrySql);

      if (!retrySql) {
        // Model gave up and returned explanation only
        context.res = {
          status: 200,
          headers: CORS,
          body: JSON.stringify({ explanation: currentExplanation, sql: '', columns: [], rows: [], rowCount: 0 }),
        };
        return;
      }

      const retrySafety = validateSqlSafety(retrySql, restrictions);
      if (!retrySafety.ok) {
        context.res = {
          status: 400,
          headers: CORS,
          body: JSON.stringify({ error: retrySafety.reason, explanation: currentExplanation, sql: retrySql }),
        };
        return;
      }

      currentSql = retrySql;
      schemaErrors = validateSchemaCompliance(currentSql, SCHEMA_LOOKUP, restrictions);
    }

    // If still invalid after retries, return the errors without hitting the DB
    if (schemaErrors.length > 0) {
      const errMsg = schemaErrors.map(e => e.message).join('; ');
      context.log.error(`[m2m-query] Schema validation still failing after ${MAX_RETRIES} retries: ${errMsg}`);
      context.res = {
        status: 400,
        headers: CORS,
        body: JSON.stringify({
          error: `The AI generated a query with invalid references: ${errMsg}. Please rephrase your question.`,
          explanation: currentExplanation,
          sql: currentSql,
        }),
      };
      return;
    }

    sqlQuery = currentSql;
    explanation = currentExplanation;

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
    // Execute SQL — schema is pre-validated, but handle remaining DB errors
    // -----------------------------------------------------------------------
    let result;
    try {
      result = await pool.request().query(sqlQuery);
    } catch (sqlErr) {
      // If it's an invalid column that slipped past validation (unqualified reference),
      // do one more targeted retry
      const invalidColMatch = sqlErr.message && sqlErr.message.match(/Invalid column name '([^']+)'/i);
      const invalidObjMatch = sqlErr.message && sqlErr.message.match(/Invalid object name '([^']+)'/i);

      if (!invalidColMatch && !invalidObjMatch) throw sqlErr;

      const badName = invalidColMatch ? invalidColMatch[1] : invalidObjMatch[1];
      const errorType = invalidColMatch ? 'column' : 'table';
      context.log.warn(`[m2m-query] DB error: Invalid ${errorType} '${badName}' — retrying`);

      const referencedTables = extractTablesFromSql(sqlQuery);
      const validTables = referencedTables.filter(t => SCHEMA_LOOKUP[t]);
      const focusedSchema = getSchemaForTables(validTables, SCHEMA_LOOKUP);

      const retryMessages = [
        ...geminiMessages,
        { role: 'model', parts: [{ text: JSON.stringify({ explanation, sql: sqlQuery }) }] },
        {
          role: 'user',
          parts: [{
            text:
              `The SQL query failed with: "${sqlErr.message}". ` +
              `Here is the EXACT schema for the relevant tables:\n\n${focusedSchema}\n\n` +
              `Generate a corrected query using ONLY these column names. Do not guess.`,
          }],
        },
      ];

      const retryGeminiBody = {
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: retryMessages,
        generationConfig: { temperature: 0.0, maxOutputTokens: 2048 },
      };

      const retryGeminiData = await callGeminiAPI(geminiUrl, retryGeminiBody);
      if (retryGeminiData._statusCode >= 400 || !retryGeminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()) throw sqlErr;

      const retryParsed = parseGeminiResponse(retryGeminiData);
      explanation = retryParsed.explanation;
      let retrySql = retryParsed.sqlQuery;
      if (retrySql) retrySql = cleanSqlQuery(retrySql);
      if (!retrySql) {
        context.res = { status: 200, headers: CORS, body: JSON.stringify({ explanation, sql: '', columns: [], rows: [], rowCount: 0 }) };
        return;
      }
      const retrySafety = validateSqlSafety(retrySql, restrictions);
      if (!retrySafety.ok) throw sqlErr;

      context.log.info(`[m2m-query] DB-error retry SQL: ${retrySql}`);
      result = await pool.request().query(retrySql);
      sqlQuery = retrySql;
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
