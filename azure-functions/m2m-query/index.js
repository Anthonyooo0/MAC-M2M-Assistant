const sql = require('mssql');
const fs = require('fs');
const path = require('path');
const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');
const {
  RESTRICTED_TABLES,
  RESTRICTED_TABLE_PATTERNS,
  RESTRICTED_COLUMNS_FLAT,
} = require('../shared/restricted');
// Generate UUID — use crypto.randomUUID() if available (Node 19+),
// fall back to manual generation for older Node runtimes (Azure Functions may use Node 16/18).
function generateRequestId() {
  try {
    return require('crypto').randomUUID();
  } catch (_e) {
    // Fallback: manual UUID v4 using random bytes
    const hex = require('crypto').randomBytes(16).toString('hex');
    return [
      hex.slice(0, 8), hex.slice(8, 12),
      '4' + hex.slice(13, 16),              // version 4
      ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20), // variant
      hex.slice(20, 32),
    ].join('-');
  }
}

// Prompt version — increment when system instructions or few-shot examples change.
// Logged with every cost record so prompt changes can be correlated with accuracy shifts.
const PROMPT_VERSION = '2.1.0';

// Shared generation config for all Gemini calls — single source of truth.
// responseMimeType + responseSchema enforce structured JSON output at the API level,
// eliminating the need for the parseGeminiResponse fallback path.
const GEMINI_GENERATION_CONFIG = {
  temperature: 0,
  maxOutputTokens: 2048,
  responseMimeType: 'application/json',
  responseSchema: {
    type: 'OBJECT',
    properties: {
      explanation: { type: 'STRING', description: 'A helpful plain-English explanation' },
      sql: { type: 'STRING', description: 'The SQL SELECT query, or empty string if no query needed' },
    },
    required: ['explanation', 'sql'],
  },
};

// ---------------------------------------------------------------------------
// Cost persistence pool — reused across invocations (same pattern as chat-sessions).
// Eliminates ~200-500ms per request from opening a fresh connection every time.
// ---------------------------------------------------------------------------
let costPoolPromise = null;

function getCostPool() {
  if (!costPoolPromise) {
    const connString = process.env.CHAT_DB_CONNECTION;
    if (!connString) return null;
    const parts = {};
    for (const segment of connString.split(';')) {
      const idx = segment.indexOf('=');
      if (idx === -1) continue;
      parts[segment.substring(0, idx).trim().toLowerCase()] = segment.substring(idx + 1).trim();
    }
    const pool = new sql.ConnectionPool({
      server: parts['server'] || parts['data source'] || '',
      database: parts['database'] || parts['initial catalog'] || '',
      user: parts['user id'] || parts['uid'] || '',
      password: parts['password'] || parts['pwd'] || '',
      options: { encrypt: true, trustServerCertificate: false },
      connectionTimeout: 5000,
      requestTimeout: 5000,
      pool: { max: 5, min: 1, idleTimeoutMillis: 30000 },
    });
    costPoolPromise = pool.connect().catch(err => {
      costPoolPromise = null;
      throw err;
    });
  }
  return costPoolPromise;
}

// Safe wrapper — resolves to the pool or null (never blocks, never throws).
// Uses a 3-second timeout so a hung cost DB never delays the user's query.
async function getCostPoolSafe() {
  try {
    const promise = getCostPool();
    if (!promise) return null;
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), 3000));
    return await Promise.race([promise, timeout]);
  } catch (_e) {
    costPoolPromise = null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// M2M/UniPoint database connection pools — reused across invocations.
// Keyed by connection string so each database gets its own pool.
// Eliminates ~500-2000ms TCP connection overhead on every query.
// ---------------------------------------------------------------------------
const dbPools = {};

function getDbPool(connString) {
  if (!connString) return null;
  if (dbPools[connString]) return dbPools[connString];

  const parts = {};
  for (const segment of connString.split(';')) {
    const idx = segment.indexOf('=');
    if (idx === -1) continue;
    parts[segment.substring(0, idx).trim().toLowerCase()] = segment.substring(idx + 1).trim();
  }

  const pool = new sql.ConnectionPool({
    server: parts['server'] || parts['data source'] || '',
    database: parts['database'] || parts['initial catalog'] || '',
    user: parts['user id'] || parts['uid'] || '',
    password: parts['password'] || parts['pwd'] || '',
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 15000,
    requestTimeout: 30000,
    pool: { max: 10, min: 1, idleTimeoutMillis: 60000 },
  });

  dbPools[connString] = pool.connect().then(() => pool).catch((_e) => {
    delete dbPools[connString];
    throw _e;
  });

  return dbPools[connString];
}

// ---------------------------------------------------------------------------
// Semantic query cache — avoids redundant Gemini calls for identical questions.
// Keyed by (question_lowercase + database). TTL-based expiry.
// ---------------------------------------------------------------------------
const QUERY_CACHE = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_SIZE = 200;

function getCacheKey(question, database) {
  return `${database}::${question.trim().toLowerCase()}`;
}

function getCachedResult(question, database) {
  const key = getCacheKey(question, database);
  const entry = QUERY_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    QUERY_CACHE.delete(key);
    return null;
  }
  return entry;
}

function setCachedResult(question, database, explanation, sqlQuery) {
  // Only cache queries that produced SQL and executed successfully
  if (!sqlQuery) return;
  const key = getCacheKey(question, database);
  // Evict oldest entries if cache is full
  if (QUERY_CACHE.size >= MAX_CACHE_SIZE) {
    const oldest = QUERY_CACHE.keys().next().value;
    QUERY_CACHE.delete(oldest);
  }
  QUERY_CACHE.set(key, { explanation, sqlQuery, timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// Cost caps — per-user daily limit and global daily ceiling.
// Checked before each Gemini call. Rejects requests that would exceed budget.
// ---------------------------------------------------------------------------
const DAILY_USER_COST_LIMIT = 5.00;    // $5/day per user
const DAILY_GLOBAL_COST_LIMIT = 25.00; // $25/day global across all users

async function checkCostCap(costPool, userEmail) {
  if (!costPool) return { ok: true }; // No cost DB — skip check
  try {
    const result = await costPool.request()
      .input('userEmail', sql.NVarChar, userEmail)
      .query(`
        SELECT
          SUM(CASE WHEN user_email = @userEmail THEN cost ELSE 0 END) AS user_today,
          SUM(cost) AS global_today
        FROM query_costs
        WHERE created_at >= CAST(GETUTCDATE() AS DATE)
      `);
    const row = result.recordset[0] || {};
    const userToday = row.user_today || 0;
    const globalToday = row.global_today || 0;

    if (userToday >= DAILY_USER_COST_LIMIT) {
      return { ok: false, reason: `Daily cost limit reached ($${userToday.toFixed(2)}/$${DAILY_USER_COST_LIMIT.toFixed(2)}). Try again tomorrow or contact an admin.` };
    }
    if (globalToday >= DAILY_GLOBAL_COST_LIMIT) {
      return { ok: false, reason: `System daily cost limit reached. Try again tomorrow or contact an admin.` };
    }
    return { ok: true };
  } catch (_e) {
    return { ok: true }; // If cost check fails, allow the request (fail open)
  }
}

// ---------------------------------------------------------------------------
// Model tiering — route simple questions to Flash (cheaper/faster),
// complex SQL generation to Pro.
// ---------------------------------------------------------------------------
const GEMINI_PRO_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_FLASH_MODEL = 'gemini-2.0-flash';

// Heuristic: if the question looks conversational (no SQL needed) or is
// extremely simple (single table, basic lookup), use Flash.
function selectModel(userMessage, hasHistory) {
  const q = userMessage.toLowerCase();

  // Conversational patterns — clearly no SQL needed
  const conversational = /\b(what does|what is|explain|help me understand|what do you|how does|tell me about|what are the fields|what columns)\b/;
  if (conversational.test(q) && !/\b(show|list|find|get|count|how many|query|select)\b/.test(q)) {
    return GEMINI_FLASH_MODEL;
  }

  // Greetings and meta-questions
  if (/^(hi|hello|hey|thanks|thank you|ok|got it)\b/.test(q) && q.length < 50) {
    return GEMINI_FLASH_MODEL;
  }

  // Everything else (SQL generation) uses Pro
  return GEMINI_PRO_MODEL;
}

function getGeminiUrl(model, apiKey) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
}

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

// MAC Products jargon glossary — translates internal terms (e.g., "raw material" → FPRODCL='00').
// Loaded once at startup and prepended to the schema in every prompt so it stays inside the
// prompt-cache window (zero token cost after first request).
const glossaryPath = path.join(__dirname, '..', 'mac-glossary.txt');
let MAC_GLOSSARY = '';
try {
  MAC_GLOSSARY = fs.readFileSync(glossaryPath, 'utf-8');
} catch (e) {
  console.error('Could not load mac-glossary.txt:', e.message);
}

// Wrap schema with glossary so it's part of the cached schema block
function buildSchemaWithGlossary(schema) {
  if (!MAC_GLOSSARY) return schema;
  return `<mac_glossary>\n${MAC_GLOSSARY}\n</mac_glossary>\n\n${schema}`;
}

// Static instructions (no schema) — cacheable by the provider
const M2M_STATIC_INSTRUCTIONS = `<system_role>
You are an AI assistant for MAC Products employees that helps them query the M2M ERP database (Made2Manage version 7.51).
Your SQL queries ARE executed automatically against the live database and results are shown to the user. You are NOT just generating SQL for the user to copy — the system runs your queries and displays results. Never tell users to copy SQL or run it themselves.

You MUST respond with valid JSON in this exact format:
{"explanation":"A helpful plain-English explanation of what the data shows, any insights, and answers to the user's question. Be conversational and helpful. If the user asked a question, answer it directly.","sql":"THE SQL QUERY HERE"}

If the user asks a general question that does NOT need a database query (like 'what am I looking at', 'explain this', 'what does this field mean', etc.), respond with:
{"explanation":"Your helpful answer here","sql":""}
</system_role>

<output_format>
{"explanation":"...","sql":"..."}
If no query needed: {"explanation":"...","sql":""}
IMPORTANT: Your response must be ONLY the JSON object. No markdown, no code blocks, no extra text. Just the JSON.
</output_format>

<restricted_tables>
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
</restricted_tables>

<restricted_columns>
Even on tables that ARE allowed, NEVER include these columns in any query:
- INPROD: FCOGSLAB, FCOGSMATL, FCOGSOVHD (COGS breakdowns)
- SOANAL: FNGRSPFT01 through FNGRSPFT12 (gross profit by period)
- JOPACT: FLABACT, FMATLACT, FOTHRACT (actual job costs)
- BLQOC / BLQOP: FNBLPROFIT, FNQUPROFIT (backlog/quote profit)
If a user asks for cost, margin, or profit data from these fields, explain that internal cost/profit data is restricted.
</restricted_columns>

<schema_rules>
The COMPLETE database schema is provided in the first message of the conversation. It lists every table (## TABLENAME) and every column under each table.
- You may ONLY use table names and column names that are EXPLICITLY listed in the schema.
- Do NOT guess, infer, or assume ANY column name exists. If a column is not listed directly under a table heading, it DOES NOT EXIST.
- Do NOT use column names you know from general M2M/ERP knowledge. This database may differ from standard M2M.
- Do NOT use column names mentioned inside the DESCRIPTION text of other columns. Descriptions are informational only — they do not define columns on the current table.
- If you cannot find the right column for what the user wants, DO NOT write SQL. Instead, set sql to "" and in your explanation list the available columns for that table and ask the user which one to use.
- NEVER fabricate a column name. When in doubt, don't query — explain what's available instead.
</schema_rules>

<query_rules>
1. ONLY generate SELECT queries. Never INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, EXEC, EXECUTE, TRUNCATE.
2. Always use TOP 500 to limit results unless the user asks for a count/aggregate.
3. ALWAYS use column aliases (AS) to give every column a clean, human-readable name. Users do not know internal field names like FSONO or FCOMPANY. Use the description from the schema as a guide.
   Examples: RTRIM(FSONO) AS "Sales Order", RTRIM(FCOMPANY) AS "Company", FORDERQTY AS "Order Qty", FORDDATE AS "Order Date"
   - Every column in every SELECT must have an AS alias with a friendly name.
   - Use double quotes around aliases that contain spaces.
   - For aggregates: COUNT(*) AS "Total Count", SUM(FORDERQTY) AS "Total Qty"
4. M2M uses fixed-width CHAR fields — always use RTRIM() when displaying or comparing text values.
5. Use proper JOIN syntax when linking tables.
6. When searching text, use LIKE with wildcards: WHERE RTRIM(fcompany) LIKE '%search%'
7. Dates of 1899-12-31 or 1900-01-01 mean "not set" — filter these out when showing dates.
8. Common table relationships:
   - SOMAST.fsono = SOITEM.fsono (Sales Order -> Line Items)
   - SOMAST.fsono = JOMAST.fsono (Sales Order -> Job Orders)
   - JOMAST.fjobno = JODRTG.fjobno (Job Order -> Routing Steps)
   - JOMAST.fjobno = JODBOM.fjobno (Job Order -> Bill of Materials)
   - POITEM.fpono = POMAST.fpono (PO Items -> PO Master)
   - POITEM.fsokey = SOMAST.fsono (PO Items -> Sales Order)
   - INMAST.fpartno = part number lookups across all tables
   - ARCUST.fcustno = customer lookups
</query_rules>

<common_corrections>
Key column corrections (common mistakes to avoid):
- SOITEM: use FQUANTITY (not fshipqty). SOMAST: use FSTATUS for status.
- POMAST/POITEM: there is NO FDUEDATE. Use POMAST.FORDDATE (order date), POMAST.FREQDATE (request date), POITEM.FREQDATE (date requested), POITEM.FORGPDATE (original promise date), POITEM.FLSTPDATE (last promise date).
- Inventory on hand: use INONHD table, FONHAND column for quantity on hand. Join to INMASTX via FPARTNO. Do NOT use INMASTX fields for on-hand qty.
- Late sales orders: compare SOMAST.FDUEDATE to GETDATE(). A sales order is late when FDUEDATE < GETDATE() and FSTATUS is not 'Closed' or 'Cancelled'.
- SOITEM pricing: use FPRICE for unit price, FORDERQTY for quantity. There is NO FUNETPRICE in SOITEM — that column is in SORELS. Use FSHIPQTY for shipped qty.
- SORELS pricing: use FUNETPRICE for unit price, FNETPRICE for net price, FORDERQTY for quantity.
</common_corrections>

<examples>
User: "Show me all open sales orders"
{"explanation":"Here are all currently open sales orders, showing the order number, customer, status, order date, and due date.","sql":"SELECT TOP 500 RTRIM(FSONO) AS \"Sales Order\", RTRIM(FCOMPANY) AS \"Customer\", RTRIM(FSTATUS) AS \"Status\", FORDDATE AS \"Order Date\", FDUEDATE AS \"Due Date\" FROM SOMAST WHERE RTRIM(FSTATUS) NOT IN ('Closed', 'Cancelled') ORDER BY FORDDATE DESC"}

User: "How many POs did we place this month?"
{"explanation":"Here is the count of purchase orders created so far this month.","sql":"SELECT COUNT(*) AS \"PO Count\" FROM POMAST WHERE FORDDATE >= DATEADD(month, DATEDIFF(month, 0, GETDATE()), 0)"}

User: "What does the FSTATUS field mean?"
{"explanation":"The FSTATUS field on the SOMAST (Sales Order Master) table indicates the current lifecycle status of a sales order. Common values include: 'Open' (active, not yet fulfilled), 'Closed' (fully shipped and invoiced), 'Cancelled' (voided before completion), and 'Started' (in progress). You can use this field to filter for active or completed orders.","sql":""}
</examples>`;

const UNIPOINT_STATIC_INSTRUCTIONS = `<system_role>
You are an AI assistant for MAC Products quality team members that helps them query the UniPoint Quality Management database.
Your SQL queries ARE executed automatically against the live database and results are shown to the user. You are NOT just generating SQL for the user to copy — the system runs your queries and displays results. Never tell users to copy SQL or run it themselves.

You MUST respond with valid JSON in this exact format:
{"explanation":"A helpful plain-English explanation of what the data shows, any insights, and answers to the user's question. Be conversational and helpful. If the user asked a question, answer it directly.","sql":"THE SQL QUERY HERE"}

If the user asks a general question that does NOT need a database query (like 'what am I looking at', 'explain this', 'what does this field mean', etc.), respond with:
{"explanation":"Your helpful answer here","sql":""}
</system_role>

<output_format>
{"explanation":"...","sql":"..."}
If no query needed: {"explanation":"...","sql":""}
IMPORTANT: Your response must be ONLY the JSON object. No markdown, no code blocks, no extra text. Just the JSON.
</output_format>

<restricted_tables>
- PT_Security_Users (user accounts, passwords)
- PT_Employee (SSN, pay rates, personal data)
- PT_Employee_Extended (passwords, login credentials)
- PT_Cashflow and all PT_Cashflow_* tables (financial data)
- PT_GST (tax configuration)
If a user asks for data from these tables, politely explain that they contain restricted information.
</restricted_tables>

<schema_rules>
The COMPLETE database schema is provided in the first message of the conversation. It lists every table (## TABLENAME) and every column under each table.
- You may ONLY use table names and column names that are EXPLICITLY listed in the schema.
- Do NOT guess, infer, or assume ANY column name exists. If a column is not listed under a table heading, it DOES NOT EXIST.
- Do NOT use column names from general UniPoint knowledge. This database may differ.
- Do NOT invent column names like "NC_Date", "Orig_Date", "Date_Reported", "Total_Cost", "Cause_Code", "Cause", "NC_No" — these do NOT exist.
- If you cannot find the right column, set sql to "" and in your explanation list the ACTUAL available columns for that table so the user can pick one.
- NEVER fabricate a column name. When in doubt, don't query — explain what's available instead.
</schema_rules>

<query_rules>
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
</query_rules>

<common_corrections>
Key column corrections (common mistakes to avoid):
- PT_NC: The date column is NCR_Date (NOT NC_Date, NOT Orig_Date, NOT Date_Reported). The cost column is NC_processing_cost (NOT Total_Cost). The ID column is NCR (NOT NC_No, NOT NC_Number). The cause/reason column is Origin_cause (NOT Cause_Code, NOT Cause). The category column is Origin_category.
- PT_CPA: The ID is CPA_no (NOT CPA_No with capital N, NOT CPA_Number). The date is CPA_date.
- PT_Inspection: The ID is Inspection_No. The date is InspectionDate.
- PT_Equip: The ID is Equip_num. The description is Equip_Desc.
- PT_Equip_Maint: The ID is Maint_num. The date is Create_date.
</common_corrections>

<examples>
User: "Show me all open non-conformance reports"
{"explanation":"Here are all currently open NCRs, showing the NCR number, status, date reported, customer, and description.","sql":"SELECT TOP 500 NCR AS \"NCR Number\", Status AS \"Status\", NCR_Date AS \"Date Reported\", Customer AS \"Customer\", Description AS \"Description\" FROM PT_NC WHERE Status NOT IN ('Closed', 'Void') ORDER BY NCR_Date DESC"}

User: "How many inspections were done this month?"
{"explanation":"Here is the count of inspections recorded so far this month.","sql":"SELECT COUNT(*) AS \"Inspection Count\" FROM PT_Inspection WHERE InspectionDate >= DATEADD(month, DATEDIFF(month, 0, GETDATE()), 0)"}

User: "What is a CPA?"
{"explanation":"A CPA (Corrective/Preventive Action) is a formal response to a quality issue. In UniPoint, CPAs are tracked in the PT_CPA table. Each CPA is linked to one or more Non-Conformance Reports (NCRs) via the CPA_No field on PT_NC. CPAs document the root cause, corrective action taken, preventive measures, and verification steps. You can ask me to look up specific CPAs or find all CPAs for a given customer or vendor.","sql":""}
</examples>`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Low-level Gemini HTTP call — no retry logic, just transport.
function callGeminiAPIOnce(geminiUrl, geminiBody) {
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

// Retryable status codes — transient errors that may resolve on a second attempt.
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);

// Resilient wrapper: retries on transient API errors (429 rate limit, 503 unavailable,
// 500 server error) and network failures, with exponential backoff.
// Non-retryable errors (400 bad request, 401 auth, 404) are returned immediately.
async function callGeminiAPI(geminiUrl, geminiBody, maxRetries = 3) {
  const delays = [1000, 2000, 4000]; // 1s, 2s, 4s exponential backoff

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await callGeminiAPIOnce(geminiUrl, geminiBody);

      // Success or non-retryable error — return immediately
      if (!result._statusCode || result._statusCode < 400 || !RETRYABLE_STATUS_CODES.has(result._statusCode)) {
        return result;
      }

      // Retryable status code — retry if attempts remain
      if (attempt < maxRetries) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // Out of retries — return the error response as-is
      return result;

    } catch (networkErr) {
      // Network-level failure (ECONNREFUSED, ETIMEDOUT, DNS failure, etc.)
      if (attempt < maxRetries) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw networkErr; // Out of retries — propagate the error
    }
  }
}

// Scrub potential PII from text before sending to Gemini (a third-party API).
// This is a best-effort filter — it catches common PII patterns but cannot
// detect all possible sensitive data (e.g., a name alone is not scrubbable).
// The goal is to prevent accidental leakage of structured PII like SSNs,
// phone numbers, and email addresses in user questions or conversation history.
function scrubPII(text) {
  return text
    // SSN patterns: 123-45-6789, 123 45 6789, 123456789 (9 consecutive digits)
    .replace(/\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, '[SSN_REDACTED]')
    // Email addresses
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL_REDACTED]')
    // US phone numbers: (123) 456-7890, 123-456-7890, 123.456.7890, 1234567890
    .replace(/\b\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[PHONE_REDACTED]')
    // Credit card numbers: 16 digits with optional separators
    .replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '[CC_REDACTED]');
}

// Compose a structured user message for Builder mode. The frontend sends real
// table/column names (mapped from descriptions client-side); we wrap them in
// XML tags so the model treats them as constraints. We still scrub PII from
// any free-text clarifier the user typed.
function composeBuilderMessage(builder, fallbackMessage) {
  const tables = (builder.tables || []).map(t => String(t).trim()).filter(Boolean);
  const columns = Array.isArray(builder.columns)
    ? builder.columns.map(c => String(c).trim()).filter(Boolean)
    : [];
  const filters = Array.isArray(builder.filters)
    ? builder.filters.filter(f => f && f.table && f.column && f.operator)
    : [];
  const clarifier = typeof builder.clarifier === 'string' ? builder.clarifier.trim() : '';
  const userMessage = (typeof fallbackMessage === 'string' && fallbackMessage.trim()) || clarifier;

  const lines = [];
  lines.push('<builder_request>');
  lines.push('The user has selected specific tables, columns, and filters using the visual Query Builder.');
  lines.push('Generate a SELECT query that uses ONLY these tables and applies these filters.');
  lines.push('Use proper JOINs based on documented relationships when multiple tables are selected.');
  lines.push('Always alias every column with a friendly description (AS "...").');
  lines.push('');
  lines.push('<tables>');
  for (const t of tables) lines.push(`- ${t}`);
  lines.push('</tables>');

  if (columns.length > 0) {
    lines.push('<columns_to_return>');
    for (const c of columns) lines.push(`- ${c}`);
    lines.push('</columns_to_return>');
  } else {
    lines.push('<columns_to_return>');
    lines.push('(none specified — pick the most useful columns from the selected tables)');
    lines.push('</columns_to_return>');
  }

  if (filters.length > 0) {
    lines.push('<filters>');
    for (const f of filters) {
      const value = f.value === undefined || f.value === null ? '' : String(f.value);
      lines.push(`- ${f.table}.${f.column} ${f.operator} ${JSON.stringify(value)}`);
    }
    lines.push('</filters>');
  }

  if (clarifier) {
    lines.push('<user_clarifier>');
    lines.push(scrubPII(clarifier));
    lines.push('</user_clarifier>');
  }

  if (userMessage && userMessage !== clarifier) {
    lines.push('<additional_request>');
    lines.push(scrubPII(userMessage));
    lines.push('</additional_request>');
  }

  lines.push('</builder_request>');
  return lines.join('\n');
}

function parseGeminiResponse(geminiData) {
  const generatedText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!generatedText) throw new Error('Gemini returned no response.');

  let cleaned = generatedText
    .replace(/^\uFEFF/, '')           // BOM
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      explanation: parsed.explanation || '',
      sqlQuery: (parsed.sql || '').trim(),
    };
  } catch (e) {
    // Do NOT fall back to treating raw text as SQL.
    // Return error state so the system can retry or inform the user.
    return {
      explanation: 'The AI returned an improperly formatted response. Please try rephrasing your question.',
      sqlQuery: '',
    };
  }
}

// ---------------------------------------------------------------------------
// Claude API integration — mirrors Gemini call pattern but uses Anthropic SDK
// ---------------------------------------------------------------------------

const CLAUDE_SONNET_MODEL = 'claude-sonnet-4-6';

// Lazy-initialized Anthropic client (reused across invocations)
let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

// Call Claude API with retry logic matching Gemini's pattern
async function callClaudeAPI(systemPrompt, schema, messages, maxRetries = 3) {
  const client = getAnthropicClient();
  if (!client) throw new Error('Anthropic API key is not configured.');

  const delays = [1000, 2000, 4000];

  // Prompt caching: system prompt is split into two blocks.
  // Block 1: static instructions (cached after first request)
  // Block 2: schema (cached after first request)
  // Both are identical across requests so Anthropic caches them server-side.
  // Requests 2+ pay 90% less for these tokens and process faster.
  const system = [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `<database_schema>\n${schema}\n</database_schema>`,
      cache_control: { type: 'ephemeral' },
    },
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.messages.create({
        model: CLAUDE_SONNET_MODEL,
        max_tokens: 2048,
        temperature: 0,
        system,
        messages,
      });
      return response;
    } catch (err) {
      const status = err.status || err.statusCode;
      const retryable = status === 429 || status === 500 || status === 503 || status === 529;
      if (retryable && attempt < maxRetries) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// Parse Claude response — expects JSON { explanation, sql } in the text content
function parseClaudeResponse(claudeData) {
  const textBlock = claudeData.content?.find(b => b.type === 'text');
  const generatedText = textBlock?.text?.trim();
  if (!generatedText) throw new Error('Claude returned no response.');

  let cleaned = generatedText
    .replace(/^\uFEFF/, '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      explanation: parsed.explanation || '',
      sqlQuery: (parsed.sql || '').trim(),
    };
  } catch (e) {
    return {
      explanation: 'The AI returned an improperly formatted response. Please try rephrasing your question.',
      sqlQuery: '',
    };
  }
}

// Extract token usage from Claude response
function extractClaudeTokenUsage(claudeResponse) {
  const usage = claudeResponse?.usage;
  if (!usage) return { input: 0, output: 0 };
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
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
  for (const table of RESTRICTED_TABLES) {
    if (new RegExp('\\b' + table + '\\b', 'i').test(sqlQuery)) {
      return { ok: false, reason: `This query references a restricted table (${table}) containing sensitive information.` };
    }
  }
  for (const pattern of RESTRICTED_TABLE_PATTERNS) {
    const wordPattern = new RegExp('\\b' + pattern.source.replace(/^\^|\$$/g, '') + '\\b', pattern.flags);
    if (wordPattern.test(sqlQuery)) {
      return { ok: false, reason: 'This query references a restricted table containing financial data.' };
    }
  }
  for (const col of RESTRICTED_COLUMNS_FLAT) {
    if (new RegExp('\\b' + col + '\\b', 'i').test(sqlQuery)) {
      return { ok: false, reason: `This query references a restricted column (${col}) containing confidential cost/profit data.` };
    }
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXEC|EXECUTE|TRUNCATE|MERGE|GRANT|REVOKE)\b/i.test(sqlQuery)) {
    return { ok: false, reason: 'Query contains forbidden keywords.' };
  }
  // Block SELECT * — forces Gemini to specify explicit columns with aliases.
  // This prevents accidental exposure of sensitive columns on otherwise-allowed tables
  // (e.g., SELECT * FROM ARCUST could return columns not covered by the restricted list).
  // The prompt instructs Gemini to always use aliases, which precludes *, but we enforce it here.
  if (/\bSELECT\s+(TOP\s+\d+\s+)?\*/i.test(sqlQuery)) {
    return { ok: false, reason: 'SELECT * is not allowed. You must specify explicit column names with aliases (AS) for every column.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Context architecture — token budgeting, selective schema, conversation trim
// ---------------------------------------------------------------------------

// Rough token estimate: ~4 characters per token for English/SQL mixed content.
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Build a table-of-contents from a schema file: just the "## TABLE — DESCRIPTION" lines.
// Used for the first phase of selective schema injection.
function buildSchemaTableOfContents(schemaText) {
  return schemaText.split('\n')
    .filter(line => line.startsWith('## '))
    .join('\n');
}

// Extract the full column block for specific tables from a schema file.
// Returns only the requested tables' definitions (header + all columns until next header).
function extractTablesFromSchema(schemaText, tableNames) {
  const lowerNames = new Set(tableNames.map(t => t.toLowerCase()));
  const lines = schemaText.split('\n');
  const result = [];
  let capturing = false;

  for (const line of lines) {
    const tableMatch = line.match(/^## (\S+)/);
    if (tableMatch) {
      capturing = lowerNames.has(tableMatch[1].toLowerCase());
    }
    if (capturing) {
      result.push(line);
    }
  }
  return result.join('\n');
}

// Parse Gemini's table selection response into an array of table names.
// Expects a JSON array or comma-separated list; handles both gracefully.
function parseTableSelection(text) {
  const cleaned = text.trim();
  // Try JSON array first
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed.map(t => String(t).trim().toUpperCase()).filter(Boolean);
    // If Gemini returned {tables: [...]} via responseSchema override
    if (parsed.tables && Array.isArray(parsed.tables)) return parsed.tables.map(t => String(t).trim().toUpperCase()).filter(Boolean);
  } catch (_e) { /* not JSON */ }
  // Fall back to extracting ## TABLE names or bare words that look like table names
  const matches = cleaned.match(/\b[A-Z_][A-Z0-9_]{2,}\b/g);
  return matches ? [...new Set(matches)] : [];
}

// Gemini 3.1 Pro context window: 1,048,576 tokens.
// We budget 80% to leave headroom for the response and safety margin.
const MAX_CONTEXT_TOKENS = Math.floor(1_048_576 * 0.80);

// Trim conversation history to fit within the token budget.
// Preserves the most recent turns (users care about recent context).
// Always keeps at least the last user message.
function trimConversationToFit(systemTokens, schemaTokens, geminiMessages) {
  const overhead = systemTokens + schemaTokens + 200; // 200 tokens for schemaAck + structural JSON
  const available = MAX_CONTEXT_TOKENS - overhead;

  // Calculate total conversation tokens
  let totalConvTokens = 0;
  for (const m of geminiMessages) {
    totalConvTokens += estimateTokens(m.parts[0].text);
  }

  if (totalConvTokens <= available) {
    return geminiMessages; // Fits — no trimming needed
  }

  // Trim from the front (oldest messages), always keep the last message (current user input)
  let trimmed = [...geminiMessages];
  let currentTokens = totalConvTokens;
  // Keep removing the oldest pair (user + model) until we fit
  while (currentTokens > available && trimmed.length > 1) {
    const removed = trimmed.shift();
    currentTokens -= estimateTokens(removed.parts[0].text);
  }

  return trimmed;
}

// ---------------------------------------------------------------------------
// Schema validator — checks SQL against actual schema before execution
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
const M2M_TABLES = parseSchemaFile(M2M_SCHEMA);
const UNIPOINT_TABLES = parseSchemaFile(UNIPOINT_SCHEMA);

// Pre-computed table-of-contents for selective schema injection
const M2M_SCHEMA_TOC = buildSchemaTableOfContents(M2M_SCHEMA);
const UNIPOINT_SCHEMA_TOC = buildSchemaTableOfContents(UNIPOINT_SCHEMA);

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
// Semantic critic — lightweight post-execution sanity check
// ---------------------------------------------------------------------------

// Detects obvious semantic mismatches between the user's question and the SQL.
// This is a heuristic filter, NOT a full NLU system. It catches the most common
// class of "technically valid but wrong" queries — missing WHERE filters when
// the user clearly asked for a filtered subset.
//
// Returns { ok: true } or { ok: false, issue: '...' } with a human-readable description.
function semanticSanityCheck(userMessage, sqlQuery, rowCount) {
  const q = userMessage.toLowerCase();
  const s = sqlQuery.toUpperCase();

  const issues = [];

  // User asked for "late" or "overdue" but SQL has no date comparison
  if (/\b(late|overdue|past due|behind schedule)\b/.test(q)) {
    if (!/\bGETDATE\b/.test(s) && !/\bCURRENT_TIMESTAMP\b/.test(s) && !/\bDATEADD\b/.test(s)) {
      issues.push('You asked about late/overdue items, but the query does not compare any date to the current date.');
    }
  }

  // User asked for "open" / "active" / "pending" but SQL has no status filter
  if (/\b(open|active|pending|in progress|not closed|not cancelled)\b/.test(q)) {
    if (!/\bWHERE\b/.test(s) || (!/STATUS/.test(s) && !/FSTATUS/.test(s) && !/FCITEMSTATUS/.test(s))) {
      // Only flag if there IS a WHERE but it doesn't touch status, or no WHERE at all
      if (!/\bWHERE\b/.test(s)) {
        issues.push('You asked for open/active items, but the query has no WHERE clause to filter by status.');
      }
    }
  }

  // User asked for a specific time period but SQL has no date filter
  if (/\b(this month|this week|this year|last month|last week|today|yesterday|this quarter)\b/.test(q)) {
    if (!/\bWHERE\b/.test(s) || (!/DATE/.test(s) && !/GETDATE/.test(s) && !/DATEADD/.test(s))) {
      issues.push('You asked about a specific time period, but the query does not filter by date.');
    }
  }

  // Suspiciously high row count for a filtered question (heuristic: >200 rows for a
  // question that includes a specific entity name suggests the filter didn't work)
  if (rowCount > 200) {
    // Check if the user mentioned a specific entity (customer, part, vendor, SO number)
    const hasSpecificEntity = /\b(for|from|by|named|called|number|#)\s+\S+/i.test(q);
    if (hasSpecificEntity && !/\bWHERE\b/.test(s)) {
      issues.push('You asked about a specific entity, but the query returned a large number of rows without filtering. The WHERE clause may be missing.');
    }
  }

  if (issues.length > 0) {
    return { ok: false, issue: issues[0] }; // Return the first/most relevant issue
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Confidence scoring — heuristic signal based on SQL structural complexity
// ---------------------------------------------------------------------------

// Scores generated SQL from 0.0 (no confidence) to 1.0 (high confidence).
// Based on structural complexity indicators, not semantic understanding.
// Returned to the frontend in _cost.confidence so it can display a signal.
//
// Scoring factors (each lowers confidence):
//   - Number of JOINs (each join is a hallucination surface)
//   - Subqueries / CTEs (higher complexity = more room for error)
//   - CASE expressions (conditional logic Gemini often gets wrong)
//   - Number of columns (broad SELECTs are less likely to be precisely right)
//   - Date math functions (common source of errors)
//   - Aggregate + GROUP BY (grouping logic is error-prone)
function scoreConfidence(sqlQuery) {
  if (!sqlQuery) return 1.0; // No SQL = conversational response, high confidence

  const s = sqlQuery.toUpperCase();
  let score = 1.0;

  // Count JOINs — each one reduces confidence
  const joinCount = (s.match(/\bJOIN\b/g) || []).length;
  score -= joinCount * 0.08; // 1 join = 0.92, 2 joins = 0.84, 3+ joins = 0.76+

  // Subqueries (SELECT inside SELECT)
  const subqueryCount = (s.match(/\bSELECT\b/g) || []).length - 1; // first SELECT doesn't count
  if (subqueryCount > 0) score -= subqueryCount * 0.10;

  // CTEs
  if (/\bWITH\b.*\bAS\s*\(/i.test(s)) score -= 0.10;

  // CASE expressions
  const caseCount = (s.match(/\bCASE\b/g) || []).length;
  score -= caseCount * 0.07;

  // Date math (DATEADD, DATEDIFF, DATEPART, CONVERT with dates)
  const dateFnCount = (s.match(/\b(DATEADD|DATEDIFF|DATEPART|CONVERT)\b/g) || []).length;
  if (dateFnCount > 1) score -= (dateFnCount - 1) * 0.05; // First date fn is fine

  // GROUP BY + HAVING
  if (/\bGROUP BY\b/.test(s)) score -= 0.05;
  if (/\bHAVING\b/.test(s)) score -= 0.05;

  // Column count (rough estimate: count commas in the SELECT ... FROM span)
  const selectToFrom = s.match(/SELECT\s+(.*?)\s+FROM/s);
  if (selectToFrom) {
    const commaCount = (selectToFrom[1].match(/,/g) || []).length;
    if (commaCount > 8) score -= 0.05; // Many columns = broader query
  }

  // UNION
  if (/\bUNION\b/.test(s)) score -= 0.10;

  return Math.max(0.0, Math.round(score * 100) / 100); // Clamp to [0, 1], 2 decimal places
}

// ---------------------------------------------------------------------------
// Token usage & cost tracking
// ---------------------------------------------------------------------------

// Gemini 3.1 Pro Preview pricing (per 1M tokens) — update if model changes
const GEMINI_COST_PER_1M_INPUT = 1.25;   // $1.25 per 1M input tokens
const GEMINI_COST_PER_1M_OUTPUT = 10.00; // $10.00 per 1M output tokens

// Claude Sonnet 4 pricing (per 1M tokens)
const CLAUDE_COST_PER_1M_INPUT = 3.00;   // $3.00 per 1M input tokens
const CLAUDE_COST_PER_1M_OUTPUT = 15.00; // $15.00 per 1M output tokens

// Legacy aliases — keep for backward compatibility with calculateCost calls
const COST_PER_1M_INPUT = GEMINI_COST_PER_1M_INPUT;
const COST_PER_1M_OUTPUT = GEMINI_COST_PER_1M_OUTPUT;

function extractTokenUsage(geminiResponse) {
  const usage = geminiResponse?.usageMetadata;
  if (!usage) return { input: 0, output: 0 };
  return {
    input: usage.promptTokenCount || 0,
    output: usage.candidatesTokenCount || 0,
  };
}

function calculateCost(inputTokens, outputTokens, modelProvider) {
  const isClaudeModel = modelProvider === 'claude';
  const costIn = isClaudeModel ? CLAUDE_COST_PER_1M_INPUT : GEMINI_COST_PER_1M_INPUT;
  const costOut = isClaudeModel ? CLAUDE_COST_PER_1M_OUTPUT : GEMINI_COST_PER_1M_OUTPUT;
  const inputCost = (inputTokens / 1_000_000) * costIn;
  const outputCost = (outputTokens / 1_000_000) * costOut;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal places
}

// ---------------------------------------------------------------------------
// Error guidance lookup table — maps SQL error patterns to corrective prompts
// ---------------------------------------------------------------------------

const SQL_ERROR_PATTERNS = [
  {
    pattern: /Incorrect syntax near/i,
    extract: /near '([^']+)'/i,
    guidance: (match) => `SQL SYNTAX error near '${match}'. Common causes:\n` +
      `- Missing comma between columns in SELECT\n` +
      `- Unmatched parentheses in function calls like DATEADD()\n` +
      `- Backslash characters (SQL Server does not use backslash escaping)\n` +
      `- Missing space between keywords\n` +
      `Rewrite the query from scratch with correct syntax.`
  },
  {
    pattern: /Invalid column name/i,
    extract: /Invalid column name '([^']+)'/i,
    guidance: (match) => `Column '${match}' does NOT exist. ` +
      `Search the schema for the correct column name. Use only columns explicitly listed under the table heading.`
  },
  {
    pattern: /Invalid object name/i,
    extract: /Invalid object name '([^']+)'/i,
    guidance: (match) => `Table '${match}' does NOT exist. Check the schema for the correct table name.`
  },
  {
    pattern: /Ambiguous column name/i,
    extract: /Ambiguous column name '([^']+)'/i,
    guidance: (match) => `Column '${match}' exists in multiple tables in your JOIN. ` +
      `Prefix it with the table name, e.g., TableName.${match}.`
  },
  {
    pattern: /conversion failed/i,
    extract: null,
    guidance: () => `Data type conversion error. Check that you are comparing the right types ` +
      `(e.g., don't compare a date to a number, use proper date formats like '2025-01-01').`
  },
];

const DEFAULT_ERROR_GUIDANCE = `Check the schema carefully and make sure every table name, column name, and SQL syntax is correct.`;

function getErrorGuidance(errorMessage) {
  for (const entry of SQL_ERROR_PATTERNS) {
    if (entry.pattern.test(errorMessage)) {
      const match = entry.extract ? (errorMessage.match(entry.extract)?.[1] || '?') : null;
      return entry.guidance(match);
    }
  }
  return DEFAULT_ERROR_GUIDANCE;
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

  // Request tracing — unique ID that links every log line, cost record, and API response
  const requestId = generateRequestId();

  let pool = null;
  let sqlQuery = '';
  let explanation = '';
  let dbServer = '?';
  let dbName = '?';
  // Token usage tracking for cost analysis
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let geminiCalls = 0;

  try {
    const { message, history, model: requestedModel, mode, builder } = req.body || {};
    const useClaudeModel = requestedModel === 'claude-sonnet';
    const isBuilderMode = mode === 'builder' && builder && typeof builder === 'object';

    if (!isBuilderMode && (!message || typeof message !== 'string' || !message.trim())) {
      context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'message is required' }) };
      return;
    }
    if (isBuilderMode && (!Array.isArray(builder.tables) || builder.tables.length === 0)) {
      context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'Builder mode requires at least one table.' }) };
      return;
    }

    // Validate API key for the selected provider
    if (useClaudeModel) {
      if (!process.env.ANTHROPIC_API_KEY) {
        context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: 'Anthropic API key is not configured.' }) };
        return;
      }
    } else {
      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) {
        context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: 'Gemini API key is not configured.' }) };
        return;
      }
    }

    // Pick connection string and system prompt based on requested database
    const { database } = req.body || {};
    let connString;
    let activeStaticInstructions = M2M_STATIC_INSTRUCTIONS;
    let activeSchema = M2M_SCHEMA;
    let activeSchemaTOC = M2M_SCHEMA_TOC;
    if (database === 'm2mdata66') {
      connString = process.env.M2M_IMPULSE_CONNECTION_STRING;
      if (!connString) {
        context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: 'MAC Impulse database connection is not configured.' }) };
        return;
      }
    } else if (database === 'unipoint_live') {
      connString = process.env.UNIPOINT_CONNECTION_STRING;
      activeStaticInstructions = UNIPOINT_STATIC_INSTRUCTIONS;
      activeSchema = UNIPOINT_SCHEMA;
      activeSchemaTOC = UNIPOINT_SCHEMA_TOC;
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

    // Prepend MAC jargon glossary inside the cached schema block so internal terms
    // (e.g., "raw material" → FPRODCL='00') resolve correctly without extra tokens
    // after the first cached request.
    activeSchema = buildSchemaWithGlossary(activeSchema);

    // Build conversation — scrub PII from all user messages before
    // they leave the network to the third-party API.
    const geminiMessages = [];
    const claudeMessages = [];

    if (Array.isArray(history)) {
      for (const turn of history) {
        if (turn.role === 'user') {
          geminiMessages.push({ role: 'user', parts: [{ text: scrubPII(turn.content) }] });
          claudeMessages.push({ role: 'user', content: scrubPII(turn.content) });
        } else if (turn.role === 'model') {
          geminiMessages.push({ role: 'model', parts: [{ text: turn.content }] });
          claudeMessages.push({ role: 'assistant', content: turn.content });
        }
      }
    }

    // Build the user-facing message text. In Builder mode, we synthesize a
    // structured constraint block so the model is locked to the user's
    // selected tables/columns/filters but still benefits from prompt caching
    // and the same retry/safety pipeline as Chat mode.
    const userMessageText = isBuilderMode
      ? composeBuilderMessage(builder, message)
      : scrubPII(message.trim());

    geminiMessages.push({ role: 'user', parts: [{ text: userMessageText }] });
    claudeMessages.push({ role: 'user', content: userMessageText });

    const modelProvider = useClaudeModel ? 'claude' : 'gemini';

    // -----------------------------------------------------------------------
    // Initial LLM call — route to Claude or Gemini based on user selection
    // -----------------------------------------------------------------------
    if (useClaudeModel) {
      // --- Claude path (with prompt caching — schema cached after first request) ---
      const claudeData = await callClaudeAPI(activeStaticInstructions, activeSchema, claudeMessages);
      { const t = extractClaudeTokenUsage(claudeData); totalInputTokens += t.input; totalOutputTokens += t.output; geminiCalls++; }

      ({ explanation, sqlQuery } = parseClaudeResponse(claudeData));

    } else {
      // --- Gemini path (unchanged) ---
      const geminiKey = process.env.GEMINI_API_KEY;
      const geminiUrl = getGeminiUrl(GEMINI_PRO_MODEL, geminiKey);

      const schemaMessage = { role: 'user', parts: [{ text: `<database_schema>\n${activeSchema}\n</database_schema>` }] };
      const schemaAck = { role: 'model', parts: [{ text: 'Schema loaded. Ready to help with database queries.' }] };
      const systemTokens = estimateTokens(activeStaticInstructions);
      const schemaTokens = estimateTokens(activeSchema);
      const trimmedMessages = trimConversationToFit(systemTokens, schemaTokens, geminiMessages);

      const geminiBody = {
        system_instruction: { parts: [{ text: activeStaticInstructions }] },
        contents: [schemaMessage, schemaAck, ...trimmedMessages],
        generationConfig: GEMINI_GENERATION_CONFIG,
      };

      const geminiData = await callGeminiAPI(geminiUrl, geminiBody);
      { const t = extractTokenUsage(geminiData); totalInputTokens += t.input; totalOutputTokens += t.output; geminiCalls++; }

      if (geminiData._statusCode && geminiData._statusCode >= 400) {
        context.log.error(`[m2m-query][${requestId}] Gemini error:`, JSON.stringify(geminiData));
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
    }

    if (sqlQuery) {
      sqlQuery = cleanSqlQuery(sqlQuery);
    }

    if (!sqlQuery) {
      context.res = {
        status: 200,
        headers: CORS,
        body: JSON.stringify({ explanation, sql: '', columns: [], rows: [], rowCount: 0, _requestId: requestId, _cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, calls: geminiCalls, cost: calculateCost(totalInputTokens, totalOutputTokens, modelProvider), model: modelProvider, confidence: 1.0 } }),
      };
      return;
    }

    // Safety checks — retry once if the model generated non-SELECT SQL
    let safety = validateSqlSafety(sqlQuery);
    if (!safety.ok) {
      context.log.warn(`[m2m-query][${requestId}] Safety check failed: ${safety.reason} — retrying`);

      const safetyRetryText = `Your query was rejected: "${safety.reason}". ` +
        `You MUST only generate SELECT queries. Do not use INSERT, UPDATE, DELETE, DROP, or any other statement type. ` +
        `Please regenerate as a SELECT query only.`;

      if (useClaudeModel) {
        const safetyRetryClaude = [
          ...claudeMessages,
          { role: 'assistant', content: JSON.stringify({ explanation, sql: sqlQuery }) },
          { role: 'user', content: safetyRetryText },
        ];
        const safetyRetryData = await callClaudeAPI(activeStaticInstructions, activeSchema, safetyRetryClaude);
        { const t = extractClaudeTokenUsage(safetyRetryData); totalInputTokens += t.input; totalOutputTokens += t.output; geminiCalls++; }
        const retryParsed = parseClaudeResponse(safetyRetryData);
        explanation = retryParsed.explanation;
        let retrySql = retryParsed.sqlQuery;
        if (retrySql) retrySql = cleanSqlQuery(retrySql);
        if (retrySql) { sqlQuery = retrySql; safety = validateSqlSafety(sqlQuery); }
      } else {
        const geminiKey = process.env.GEMINI_API_KEY;
        const geminiUrl = getGeminiUrl(GEMINI_PRO_MODEL, geminiKey);
        const schemaMessage = { role: 'user', parts: [{ text: `<database_schema>\n${activeSchema}\n</database_schema>` }] };
        const schemaAck = { role: 'model', parts: [{ text: 'Schema loaded. Ready to help with database queries.' }] };
        const safetyRetryMessages = [
          ...geminiMessages,
          { role: 'model', parts: [{ text: JSON.stringify({ explanation, sql: sqlQuery }) }] },
          { role: 'user', parts: [{ text: safetyRetryText }] },
        ];

        const safetyRetryBody = {
          system_instruction: { parts: [{ text: activeStaticInstructions }] },
          contents: [schemaMessage, schemaAck, ...safetyRetryMessages],
          generationConfig: GEMINI_GENERATION_CONFIG,
        };

        const safetyRetryData = await callGeminiAPI(geminiUrl, safetyRetryBody);
        { const t = extractTokenUsage(safetyRetryData); totalInputTokens += t.input; totalOutputTokens += t.output; geminiCalls++; }
        if (safetyRetryData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()) {
          const retryParsed = parseGeminiResponse(safetyRetryData);
          explanation = retryParsed.explanation;
          let retrySql = retryParsed.sqlQuery;
          if (retrySql) retrySql = cleanSqlQuery(retrySql);
          if (retrySql) { sqlQuery = retrySql; safety = validateSqlSafety(sqlQuery); }
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

    // Validate SQL against schema before executing (all databases)
    const activeSchemaTables = database === 'unipoint_live' ? UNIPOINT_TABLES : M2M_TABLES;
    if (sqlQuery && Object.keys(activeSchemaTables).length > 0) {
      const schemaCheck = validateAgainstSchema(sqlQuery, activeSchemaTables);
      if (!schemaCheck.ok) {
        context.log.warn(`[m2m-query][${requestId}] Schema validation failed: ${schemaCheck.errors.join('; ')} — retrying`);

        const schemaRetryText = `Your SQL query failed schema validation before execution. The following problems were found:\n` +
          schemaCheck.errors.map(e => `- ${e}`).join('\n') + '\n\n' +
          `You MUST only use table and column names from the schema. Please fix these errors and regenerate the query.`;

        let retryParsed;
        if (useClaudeModel) {
          const schemaRetryClaude = [
            ...claudeMessages,
            { role: 'assistant', content: JSON.stringify({ explanation, sql: sqlQuery }) },
            { role: 'user', content: schemaRetryText },
          ];
          const schemaRetryData = await callClaudeAPI(activeStaticInstructions, activeSchema, schemaRetryClaude);
          { const t = extractClaudeTokenUsage(schemaRetryData); totalInputTokens += t.input; totalOutputTokens += t.output; geminiCalls++; }
          retryParsed = parseClaudeResponse(schemaRetryData);
        } else {
          const geminiKey = process.env.GEMINI_API_KEY;
          const geminiUrl = getGeminiUrl(GEMINI_PRO_MODEL, geminiKey);
          const schemaMessage = { role: 'user', parts: [{ text: `<database_schema>\n${activeSchema}\n</database_schema>` }] };
          const schemaAck = { role: 'model', parts: [{ text: 'Schema loaded. Ready to help with database queries.' }] };
          const schemaRetryMessages = [
            ...geminiMessages,
            { role: 'model', parts: [{ text: JSON.stringify({ explanation, sql: sqlQuery }) }] },
            { role: 'user', parts: [{ text: schemaRetryText }] },
          ];
          const schemaRetryBody = {
            system_instruction: { parts: [{ text: activeStaticInstructions }] },
            contents: [schemaMessage, schemaAck, ...schemaRetryMessages],
            generationConfig: GEMINI_GENERATION_CONFIG,
          };
          const schemaRetryData = await callGeminiAPI(geminiUrl, schemaRetryBody);
          { const t = extractTokenUsage(schemaRetryData); totalInputTokens += t.input; totalOutputTokens += t.output; geminiCalls++; }
          if (schemaRetryData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()) {
            retryParsed = parseGeminiResponse(schemaRetryData);
          }
        }

        if (retryParsed) {
          explanation = retryParsed.explanation;
          let retrySql = retryParsed.sqlQuery;
          if (retrySql) retrySql = cleanSqlQuery(retrySql);

          if (retrySql) {
            const retrySchemaCheck = validateAgainstSchema(retrySql, activeSchemaTables);
            if (retrySchemaCheck.ok) {
              sqlQuery = retrySql;
            } else {
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

    // Get or create a pooled connection — reused across invocations
    try {
      pool = await getDbPool(connString);
    } catch (_e) {
      // Pool failed — reset and try once more
      delete dbPools[connString];
      pool = await getDbPool(connString);
    }
    context.log.info(`[m2m-query][${requestId}] Connected (pooled)`);

    // -----------------------------------------------------------------------
    // Execute SQL — with up to 2 retries on any SQL error
    // -----------------------------------------------------------------------
    const MAX_RETRIES = 2;
    let result;
    let lastError = null;
    let retryConversationGemini = [...geminiMessages];
    let retryConversationClaude = [...claudeMessages];

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        result = await pool.request().query(sqlQuery);
        lastError = null;
        break; // Success — exit the retry loop
      } catch (sqlErr) {
        lastError = sqlErr;

        // If the connection dropped, reset the pool and reconnect
        if (sqlErr.code === 'ECONNCLOSED' || sqlErr.code === 'ENOTOPEN' || sqlErr.code === 'ESOCKET') {
          delete dbPools[connString];
          try {
            pool = await getDbPool(connString);
            context.log.warn(`[m2m-query][${requestId}] Connection reset — reconnected`);
          } catch (_e) {
            context.log.error(`[m2m-query][${requestId}] Reconnect failed`);
          }
        }

        if (attempt >= MAX_RETRIES) {
          // Out of retries — will throw below
          break;
        }

        context.log.warn(`[m2m-query][${requestId}] SQL error (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — retrying: ${sqlErr.message}`);

        const errMsg = sqlErr.message || '';
        const fixGuidance = getErrorGuidance(errMsg);
        const retryText = `The SQL query you generated failed with this database error:\n` +
          `"${errMsg}"\n\n` +
          `The failed query was:\n${sqlQuery}\n\n` +
          `${fixGuidance}\n\n` +
          `Generate a corrected query using ONLY columns from the schema.`;

        let retryParsed;

        if (useClaudeModel) {
          retryConversationClaude = [
            ...retryConversationClaude,
            { role: 'assistant', content: JSON.stringify({ explanation, sql: sqlQuery }) },
            { role: 'user', content: retryText },
          ];
          try {
            const retryData = await callClaudeAPI(activeStaticInstructions, activeSchema, retryConversationClaude);
            { const t = extractClaudeTokenUsage(retryData); totalInputTokens += t.input; totalOutputTokens += t.output; geminiCalls++; }
            retryParsed = parseClaudeResponse(retryData);
          } catch (retryErr) {
            context.log.error(`[m2m-query][${requestId}] Claude retry error:`, retryErr.message);
            break;
          }
        } else {
          const geminiKey = process.env.GEMINI_API_KEY;
          const geminiUrl = getGeminiUrl(GEMINI_PRO_MODEL, geminiKey);
          const schemaMessage = { role: 'user', parts: [{ text: `<database_schema>\n${activeSchema}\n</database_schema>` }] };
          const schemaAck = { role: 'model', parts: [{ text: 'Schema loaded. Ready to help with database queries.' }] };

          retryConversationGemini = [
            ...retryConversationGemini,
            { role: 'model', parts: [{ text: JSON.stringify({ explanation, sql: sqlQuery }) }] },
            { role: 'user', parts: [{ text: retryText }] },
          ];

          const systemTokens = estimateTokens(activeStaticInstructions);
          const schemaTokens = estimateTokens(activeSchema);
          const trimmedRetryConv = trimConversationToFit(systemTokens, schemaTokens, retryConversationGemini);

          const retryGeminiBody = {
            system_instruction: { parts: [{ text: activeStaticInstructions }] },
            contents: [schemaMessage, schemaAck, ...trimmedRetryConv],
            generationConfig: GEMINI_GENERATION_CONFIG,
          };

          const retryGeminiData = await callGeminiAPI(geminiUrl, retryGeminiBody);
          { const t = extractTokenUsage(retryGeminiData); totalInputTokens += t.input; totalOutputTokens += t.output; geminiCalls++; }

          if (retryGeminiData._statusCode && retryGeminiData._statusCode >= 400) {
            context.log.error(`[m2m-query][${requestId}] Gemini retry error:`, JSON.stringify(retryGeminiData));
            break;
          }

          if (!retryGeminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()) {
            break;
          }

          retryParsed = parseGeminiResponse(retryGeminiData);
        }

        if (!retryParsed) break;

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

        context.log.info(`[m2m-query][${requestId}] Retry ${attempt + 1} SQL: ${retrySqlQuery}`);
        sqlQuery = retrySqlQuery;
      }
    }

    if (lastError) {
      throw lastError;
    }

    // -----------------------------------------------------------------------
    // Zero-row retry: if query returned no results, ask the model to broaden it
    // -----------------------------------------------------------------------
    if (result.recordset.length === 0) {
      context.log.info(`[m2m-query][${requestId}] Query returned 0 rows — retrying with broader criteria`);

      const zeroRowText = `The query you generated ran successfully but returned ZERO rows. This likely means your WHERE filters are too restrictive. Common issues:\n` +
        `- Text comparisons: use LIKE '%keyword%' instead of exact match (= 'value'). M2M uses CHAR fields with trailing spaces.\n` +
        `- Date filters: try a wider date range, or check if you're using the right date column. POMAST has FORDDATE (order date) and FREQDATE (request date); POITEM has FREQDATE, FORGPDATE (original promise), FLSTPDATE (last promise).\n` +
        `- Status filters: don't filter by status unless the user specifically asked for a status.\n` +
        `- The data may exist but with slightly different spelling or format.\n\n` +
        `Please regenerate the query with BROADER filters to find the data. Use LIKE with wildcards for text, widen date ranges, and remove unnecessary status filters.`;

      let zeroRowParsed;

      if (useClaudeModel) {
        const zeroRowClaude = [
          ...claudeMessages,
          { role: 'assistant', content: JSON.stringify({ explanation, sql: sqlQuery }) },
          { role: 'user', content: zeroRowText },
        ];
        try {
          const zeroRowData = await callClaudeAPI(activeStaticInstructions, activeSchema, zeroRowClaude);
          { const t = extractClaudeTokenUsage(zeroRowData); totalInputTokens += t.input; totalOutputTokens += t.output; geminiCalls++; }
          zeroRowParsed = parseClaudeResponse(zeroRowData);
        } catch (zeroErr) {
          context.log.warn(`[m2m-query][${requestId}] Claude zero-row retry failed: ${zeroErr.message}`);
        }
      } else {
        const geminiKey = process.env.GEMINI_API_KEY;
        const geminiUrl = getGeminiUrl(GEMINI_PRO_MODEL, geminiKey);
        const schemaMessage = { role: 'user', parts: [{ text: `<database_schema>\n${activeSchema}\n</database_schema>` }] };
        const schemaAck = { role: 'model', parts: [{ text: 'Schema loaded. Ready to help with database queries.' }] };
        const zeroRowMessages = [
          ...geminiMessages,
          { role: 'model', parts: [{ text: JSON.stringify({ explanation, sql: sqlQuery }) }] },
          { role: 'user', parts: [{ text: zeroRowText }] },
        ];
        const zeroRowBody = {
          system_instruction: { parts: [{ text: activeStaticInstructions }] },
          contents: [schemaMessage, schemaAck, ...zeroRowMessages],
          generationConfig: GEMINI_GENERATION_CONFIG,
        };
        const zeroRowData = await callGeminiAPI(geminiUrl, zeroRowBody);
        { const t = extractTokenUsage(zeroRowData); totalInputTokens += t.input; totalOutputTokens += t.output; geminiCalls++; }
        if (zeroRowData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()) {
          zeroRowParsed = parseGeminiResponse(zeroRowData);
        }
      }

      if (zeroRowParsed) {
        let zeroRowSql = zeroRowParsed.sqlQuery;
        if (zeroRowSql) zeroRowSql = cleanSqlQuery(zeroRowSql);

        if (zeroRowSql) {
          const zeroRowSafety = validateSqlSafety(zeroRowSql);
          if (zeroRowSafety.ok) {
            try {
              const zeroRowResult = await pool.request().query(zeroRowSql);
              if (zeroRowResult.recordset.length > 0) {
                result = zeroRowResult;
                sqlQuery = zeroRowSql;
                explanation = zeroRowParsed.explanation || explanation;
                context.log.info(`[m2m-query][${requestId}] Zero-row retry found ${zeroRowResult.recordset.length} rows`);
              }
            } catch (retryErr) {
              context.log.warn(`[m2m-query][${requestId}] Zero-row retry SQL failed: ${retryErr.message}`);
            }
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // Semantic critic — lightweight sanity check on the query vs user intent.
    // Appends a warning to the explanation if a mismatch is detected.
    // Advisory only — never blocks the response.
    // -----------------------------------------------------------------------
    if (sqlQuery && result.recordset.length > 0) {
      const sanity = semanticSanityCheck(message, sqlQuery, result.recordset.length);
      if (!sanity.ok) {
        context.log.warn(`[m2m-query][${requestId}] Semantic critic flagged: ${sanity.issue}`);
        explanation += `\n\nNote: ${sanity.issue} You may want to refine your question if the results don't look right.`;
      }
    }

    // Cache successful SQL generation for future identical questions
    if (sqlQuery && result.recordset.length > 0) {
      setCachedResult(message, database || 'm2mdata99', explanation, sqlQuery);
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
        _requestId: requestId,
        _cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, calls: geminiCalls, cost: calculateCost(totalInputTokens, totalOutputTokens, modelProvider), model: modelProvider, confidence: scoreConfidence(sqlQuery) },
      }),
    };

  } catch (err) {
    context.log.error(`[m2m-query][${requestId}] Error:`, err);
    const modelProvider = useClaudeModel ? 'claude' : 'gemini';
    context.res = {
      status: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message || String(err), sql: sqlQuery || '', _requestId: requestId, _cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, calls: geminiCalls, cost: calculateCost(totalInputTokens, totalOutputTokens, modelProvider), model: modelProvider } }),
    };
  } finally {
    // Pool is NOT closed — it's reused across invocations.
    // If the pool has a connection error, getDbPool will reset it on the next request.
    // Save cost — fire-and-forget so the user doesn't wait for it.
    // Uses a dedicated connection. If it fails, cost is logged but not lost
    // (the _cost is already in the API response and chat_messages).
    if (geminiCalls > 0) {
      const chatConnStr = process.env.CHAT_DB_CONNECTION;
      if (chatConnStr) {
        // Don't await — let it run in the background
        (async () => {
          let cp = null;
          try {
            const costParts = {};
            for (const seg of chatConnStr.split(';')) {
              const idx = seg.indexOf('=');
              if (idx === -1) continue;
              costParts[seg.substring(0, idx).trim().toLowerCase()] = seg.substring(idx + 1).trim();
            }
            cp = new sql.ConnectionPool({
              server: costParts['server'] || costParts['data source'] || '',
              database: costParts['database'] || costParts['initial catalog'] || '',
              user: costParts['user id'] || costParts['uid'] || '',
              password: costParts['password'] || costParts['pwd'] || '',
              options: { encrypt: true, trustServerCertificate: false },
              connectionTimeout: 10000,
              requestTimeout: 10000,
            });
            await cp.connect();
            await cp.request()
              .input('sessionId', sql.UniqueIdentifier, req.body?.sessionId || null)
              .input('userEmail', sql.NVarChar, req.body?.userEmail || 'unknown')
              .input('databaseName', sql.NVarChar, req.body?.database === 'unipoint_live' ? 'UniPoint Quality' : req.body?.database === 'm2mdata66' ? 'MAC Impulse' : 'MAC Products')
              .input('inputTokens', sql.Int, totalInputTokens)
              .input('outputTokens', sql.Int, totalOutputTokens)
              .input('geminiCalls', sql.Int, geminiCalls)
              .input('cost', sql.Float, calculateCost(totalInputTokens, totalOutputTokens, useClaudeModel ? 'claude' : 'gemini'))
              .input('promptVersion', sql.NVarChar, PROMPT_VERSION + (useClaudeModel ? '-claude' : '') + (isBuilderMode ? '+builder' : ''))
              .input('requestId', sql.NVarChar, requestId)
              .query(`INSERT INTO query_costs (session_id, user_email, database_name, input_tokens, output_tokens, gemini_calls, cost, prompt_version, request_id)
                      VALUES (@sessionId, @userEmail, @databaseName, @inputTokens, @outputTokens, @geminiCalls, @cost, @promptVersion, @requestId)`);
          } catch (costErr) {
            // Log but don't crash — cost data is also in the API response
            console.error(`[m2m-query][${requestId}] Cost save failed: ${costErr.message}`);
          } finally {
            if (cp) { try { await cp.close(); } catch (_e) { /* ignore */ } }
          }
        })();
      }
    }
  }
};

// Expose internals for the eval harness (test-only). The Azure Functions runtime
// uses the default export (the handler function above); tests use ._internals.
module.exports._internals = {
  validateSqlSafety,
  validateAgainstSchema,
  parseGeminiResponse,
  cleanSqlQuery,
  getErrorGuidance,
  semanticSanityCheck,
  scoreConfidence,
  scrubPII,
  parseSchemaFile,
  M2M_TABLES,
  UNIPOINT_TABLES,
  M2M_SCHEMA,
  UNIPOINT_SCHEMA,
  PROMPT_VERSION,
};
