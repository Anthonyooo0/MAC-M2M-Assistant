# ARCHITECTURE

## 1. What this is

The M2M Assistant lets MAC Products staff ask questions in plain English about the
Made2Manage ERP, and gets back a real table of rows. A React web app takes the question,
an Azure Function turns it into SQL with Claude, runs that SQL against the live ERP, and
returns the results.

Users are MAC Products employees who do not write SQL. Three databases are reachable:
MAC Products ERP, MAC Impulse ERP, and UniPoint Quality.

---

## 2. Repo layout

### Root

| Path | What it is |
|---|---|
| `src/` | The React frontend (TypeScript, Vite, MSAL auth) |
| `azure-functions/` | The backend. One folder per HTTP endpoint |
| `docs/SYSTEM_SPEC.md` | Success criteria, latency and accuracy targets |
| `docs/SYSTEM_DESIGN.md` | Narrative walkthrough of the system, written for interviews |
| `index.html` | Vite entry page |
| `package.json` | Frontend deps and scripts (`dev`, `build`, `lint`, `preview`) |
| `vite.config.ts`, `tsconfig*.json`, `eslint.config.js` | Build and lint config |
| `deploy.ps1` | Zips the `azure-functions` folder and ZipDeploys it to Azure |
| `check.ps1` | Pings the Function App and reads its latest deployment status |
| `.github/workflows/azure-static-web-apps-*.yml` | Builds and deploys the frontend on push to `main` |
| `m2m_schema.txt` | Full dumped ERP schema (1.1 MB). Not read at runtime |
| `notes/`, `scripts/`, `RESUME_SOURCE.md` | Learning notes, one-off `.cjs` probes, personal project log. Not part of the app |

Untracked data files also sit in the root (`.xlsx`, `.csv`, `.pdf`, `deploy.zip`) — working
artifacts, not app inputs.

### `src/`

| File | What it owns |
|---|---|
| `App.tsx` | Everything: auth gate, chat state, sessions, company switcher, presets, the fetch to the backend |
| `authConfig.ts` | MSAL config and `ALLOWED_DOMAINS` |
| `main.tsx` | React root, wraps `App` in the MSAL provider |
| `components/ChatMessage.tsx` | Renders one chat bubble |
| `components/ResultsTable.tsx` | Renders the result grid, plus the source-field popover |
| `components/QueryBuilder.tsx` | Visual table/column/filter picker (Builder mode) |
| `components/AdminView.tsx` | Admin list of other users' chat sessions |
| `components/CostDashboard.tsx` | Token and cost charts |
| `components/Login.tsx`, `components/NickCountdown.tsx` | Sign-in screen; a retirement countdown widget |

### `azure-functions/`

| Folder | What it does |
|---|---|
| `m2m-query/` | **The main endpoint.** Question in, SQL generated, executed, rows out |
| `chat-sessions/` | Create, list, rename, delete chat sessions |
| `chat-messages/` | Save and load messages for a session; record thumbs up/down |
| `query-costs/` | Cost and token summaries for the dashboard |
| `schema-meta/` | Serves the table/column list that Query Builder picks from |
| `m2m-status/` | Sales-order lookup: header, lines, jobs, routing, linked POs |
| `activity-report/` | Read-only "who has been querying" report, app DB only |
| `open-po-overseas/` | Open PO lines for a fixed overseas vendor list (tariff dashboard) |
| `shared/restricted.js` | Single source of truth for tables and columns that must never be queried |
| `shared/db.js` | Shared connection-pool helper and `withQuery()` retry wrapper |
| `m2m-schema-slim.txt` | The curated ERP schema sent to Claude in every prompt |
| `unipoint-schema-slim.txt` | Same, for UniPoint |
| `mac-glossary.txt` | MAC jargon translations, e.g. "raw material" to `FPRODCL='00'` |
| `schema.sql` | DDL for the app's own Azure SQL tables |
| `m2m-query/eval.js` | Offline test harness over the validator functions |
| `m2m-query/eval-canary.js` | Hits the live endpoint with 5 canonical questions to detect drift |
| `m2m-query/test-queries.json` | The golden test set |

These function folders exist on disk and are deployed by `deploy.ps1`, but are **not in
git**: `m2m-backorder-report`, `m2m-backorder-report-refresh`, `m2m-bom-tree`,
`m2m-pick-list`, `m2m-pick-list-bulk`, `wabtec-m2m-orphans`, `wabtec-po-compare`,
`wabtec-po-find-everywhere`.

---

## 3. Request flow

Example question: **"how many of part 41B531222G2 are on open orders"**

1. **User presses Enter.** `handleSend` in `src/App.tsx:511` reads the textarea, clears it,
   and calls `submitQuery(text)`.

2. **Frontend builds the payload.** `submitQuery` in `src/App.tsx:353` adds a user bubble
   and a loading bubble, then builds `history` from the last 8 non-loading messages
   (`src/App.tsx:395`). Assistant turns get their SQL appended as
   `[SQL I ran for this answer]:` so follow-ups can reuse the exact filter.

3. **POST goes out.** `src/App.tsx:409` fetches `VITE_M2M_QUERY_URL`. Body holds
   `message` ("how many of part 41B531222G2 are on open orders"), `history`,
   `database` ("m2mdata99"), `userEmail`, `sessionId`, `model` ("claude-sonnet").

4. **Handler entry.** `module.exports` in `azure-functions/m2m-query/index.js:1117`.
   An `OPTIONS` request returns CORS headers and stops (`index.js:1119`). A `requestId`
   is generated for log correlation (`index.js:1137`).

5. **Body is destructured and the mode chosen.** `index.js:1177`. `isBuilderMode` is true
   only when `mode === 'builder'` (`index.js:1187`); `isRawMode` is true only when a
   non-empty `rawSql` string was posted (`index.js:1194`). Our example is neither, so it
   takes the plain chat path.

6. **Database and prompt are selected.** `index.js:1216-1236`. `database === 'm2mdata99'`
   falls to the `else`, so `connString = process.env.M2M_CONNECTION_STRING`,
   `activeStaticInstructions = M2M_STATIC_INSTRUCTIONS`, `activeSchema = M2M_SCHEMA`.

7. **Glossary is prepended to the schema.** `buildSchemaWithGlossary` at
   `index.js:228`, called at `index.js:1241`. `activeSchema` now starts with a
   `<mac_glossary>` block.

8. **Conversation is assembled and scrubbed.** `index.js:1280-1290` copies history into
   `claudeMessages`, running every user turn through `scrubPII` (`index.js:450`).
   `userMessageText` is set at `index.js:1296` — for chat mode, the scrubbed question.

9. **Cache is checked.** `index.js:1315-1317`. `cacheable` requires chat mode, a
   `message`, and **no** history. On a first-turn question `cached` may be a hit from
   `getCachedResult` (`index.js:141`), keyed `(question, database)` with a 1-hour TTL.
   A hit skips steps 10 and 11 but still executes the SQL, so rows are always fresh.

10. **Clarifier runs.** `index.js:1327` calls `runClarifier` (`index.js:576`), a Haiku call
    with a 4-second timeout. It returns either `{ok:false, question}` — in which case
    `index.js:1336` returns the question to the user and stops — or
    `{ok:true, constraints}`. `constraints` holds `{status: 'Open'}` for our example, and
    is stored in the handler variable at `index.js:1329`.

11. **Claude generates SQL.** `index.js:1373` calls `callClaudeAPI` (`index.js:640`) with
    the static instructions and schema as two cached system blocks.
    `parseClaudeResponse` (`index.js:688`) pulls `{explanation, sqlQuery}` out of the JSON.
    `sqlQuery` now holds something like
    `SELECT ... FROM SOMAST WHERE RTRIM(FPARTNO) LIKE '%41B531222G2%'`.

12. **SQL is cleaned.** `cleanSqlQuery` at `index.js:777`, called at `index.js:1380`.
    Strips comments and pulls the `SELECT` out if the model wrapped it in prose. If
    `sqlQuery` is empty the handler returns the explanation alone (`index.js:1383`).

13. **Safety check.** `validateSqlSafety` (`index.js:782`) at `index.js:1393`. Rejects
    non-SELECT statements, restricted tables and columns from `shared/restricted.js`,
    write keywords, and `SELECT *`.

14. **Schema check.** `validateAgainstSchema` (`index.js:843`) at `index.js:1430`, using
    `activeSchemaTables` picked one line earlier. Confirms every table and every
    `table.column` reference exists in the parsed schema.

15. **Pooled connection.** `getDbPool` (`index.js:99`) at `index.js:1474`. Pools are keyed
    by connection string and reused across invocations.

16. **Execute.** `index.js:1492`, inside a loop that allows `MAX_RETRIES = 2` (three
    attempts total). On success, `result.recordset` holds the rows.

17. **Zero-row retry.** `index.js:1578`. If the recordset is empty and this is not raw
    mode, the model is asked once to broaden the query.

18. **Semantic critic.** `semanticSanityCheck` (`index.js:929`) at `index.js:1623`. Runs
    only when there is at least one row. Appends a warning sentence to the explanation.
    Advisory — never blocks.

19. **Cache write.** `setCachedResult` (`index.js:152`) at `index.js:1635`, gated on
    `cacheable` and a non-empty result.

20. **Response.** `index.js:1641`. Body carries `explanation`, `sql`, `columns`,
    `columnSources` (from `parseColumnSources`, `index.js:735`), `rows`, `rowCount`,
    `_requestId`, and `_cost`.

21. **Cost is recorded.** The `finally` block at `index.js:1663` fires an un-awaited
    async insert into `query_costs` on `CHAT_DB_CONNECTION`.

22. **Frontend renders.** `src/App.tsx:425-472` turns the response into an assistant
    message and swaps it in for the loading bubble. `src/App.tsx:476` saves both messages
    via `saveMessages`. `ResultsTable` renders the grid.

### Branches that skip stages

**Builder mode** — `mode: 'builder'` from `handleBuilderSubmit` (`src/App.tsx:518`).
`composeBuilderMessage` (`index.js:466`) replaces the free-text question with an XML
constraint block. Skips the clarifier and the cache (`index.js:1316`, `index.js:1327`).

**Raw-SQL presets** — the preset buttons at `src/App.tsx:984-1042` post `rawSql`.
`index.js:1364` uses that SQL verbatim: no clarifier, no cache, no model call. It still
goes through safety and schema checks, but a failure is **reported** rather than repaired
(`index.js:1398`, `index.js:1433`), and the zero-row retry is skipped (`index.js:1578`).

**Cache hit** — `index.js:1366` reuses the stored explanation and SQL. Clarifier and
generation are both skipped; execution still happens.

**Activity report** — `src/App.tsx:1050` posts to a different URL derived at
`src/App.tsx:24`, so it never enters `m2m-query` at all.

---

## 4. Recovery paths

| # | Trigger | What the model is told | Attempts | When exhausted |
|---|---|---|---|---|
| 1 | Anthropic HTTP 429/500/503/529 (`index.js:676`) | Nothing — plain resend | 3 retries, delays 1s/2s/4s (`index.js:644`) | Throws; caught at `index.js:1656`, returns 500 |
| 2 | Safety check failed (`index.js:1394`) | "Your query was rejected: ... You MUST only generate SELECT queries" (`index.js:1409`) | 1 repair | 400 with `safety.reason` (`index.js:1418`) |
| 3 | Schema check failed (`index.js:1431`) | The list of bad tables/columns plus "You MUST only use table and column names from the schema" (`index.js:1444`) | 1 repair, then revalidated | 400 with the remaining errors (`index.js:1457`) |
| 4 | SQL error at execution (`index.js:1495`) | The database error text, the failed query, and targeted advice from `getErrorGuidance` (`index.js:1103`) | `MAX_RETRIES = 2`, so 3 executions | `lastError` rethrown at `index.js:1568`, becomes a 500 |
| 5 | Connection dropped: `ECONNCLOSED`/`ENOTOPEN`/`ESOCKET` (`index.js:1498`) | Nothing — pool is deleted and rebuilt | Inside the same 3-attempt loop | Falls through to path 4 |
| 6 | Zero rows returned (`index.js:1578`) | "returned ZERO rows ... regenerate the query with BROADER filters" (`index.js:1581`) | 1 attempt, best-effort | Original zero-row result stands (`index.js:1588`) |
| 7 | Pool creation threw (`index.js:1475`) | n/a | Deletes the cached pool, tries once more | Throws to the outer catch |
| 8 | Clarifier failed or timed out (`index.js:623`) | n/a | None | Returns `{ok:true}` — fails open, query proceeds without constraints |
| 9 | Cost insert failed (`index.js:1707`) | n/a | None | Logged only. Cost still rides back on the response |
| 10 | Semantic mismatch detected (`index.js:1625`) | n/a | None | A note is appended to the explanation. Never blocks |

Paths 2, 3, 4, and 6 all run through one shared helper: `repair`, defined at
`index.js:1262`. It appends the assistant's last output and the reason text to a message
list, calls Claude, and returns `{explanation, sql, messages}`.

Every repair round trip is counted by `accrueUsage` (`index.js:1160`), which increments
`geminiCalls`. That counter therefore includes the clarifier call.

---

## 5. External dependencies

### Services

| System | Reached by | Via |
|---|---|---|
| Anthropic API | `callClaudeAPI` (`index.js:640`), `runClarifier` (`index.js:576`) | `@anthropic-ai/sdk`, client built in `getAnthropicClient` (`index.js:630`) |
| MAC Products ERP (`m2mdata99`) | `m2m-query`, `m2m-status`, `open-po-overseas`, and the untracked report functions | `mssql`, pooled |
| MAC Impulse ERP (`m2mdata66`) | `m2m-query` only (`index.js:1217`) | `mssql`, pooled |
| UniPoint Quality | `m2m-query` only (`index.js:1223`) | `mssql`, pooled |
| App database (Azure SQL) | `chat-sessions`, `chat-messages`, `query-costs`, `activity-report`, and `m2m-query`'s cost insert | `mssql`. Tables in `azure-functions/schema.sql` |
| Microsoft Entra ID | `src/main.tsx` and `src/App.tsx:107` | `@azure/msal-react`, config in `src/authConfig.ts` |

### Backend environment variables

| Variable | Read by |
|---|---|
| `ANTHROPIC_API_KEY` | `m2m-query/index.js:632`, checked at `index.js:1206` |
| `M2M_CONNECTION_STRING` | `m2m-query`, `m2m-status`, `open-po-overseas`, `m2m-bom-tree`, `m2m-pick-list`, `m2m-pick-list-bulk`, `m2m-backorder-report`, `m2m-backorder-report-refresh`, `wabtec-po-compare`, `wabtec-po-find-everywhere`, `wabtec-m2m-orphans` |
| `M2M_IMPULSE_CONNECTION_STRING` | `m2m-query/index.js:1217` |
| `UNIPOINT_CONNECTION_STRING` | `m2m-query/index.js:1223` |
| `CHAT_DB_CONNECTION` | `chat-sessions`, `chat-messages`, `query-costs`, `activity-report`, `m2m-query/index.js:1670` |
| `CHAT_ADMINS` | `chat-sessions/index.js` |

### Frontend build variables

Set as GitHub Actions secrets in `.github/workflows/azure-static-web-apps-yellow-sea-087d83a1e.yml`
and read in `src/App.tsx:13-17`: `VITE_M2M_QUERY_URL`, `VITE_CHAT_SESSIONS_URL`,
`VITE_CHAT_MESSAGES_URL`, `VITE_QUERY_COSTS_URL`, `VITE_SCHEMA_META_URL`.

`ACTIVITY_REPORT_URL` is not a variable — it is derived by string replacement at
`src/App.tsx:24`.

Every Function URL carries a `?code=` function key, because `m2m-query/function.json`
sets `"authLevel": "function"`.

---

## 6. Design decisions

These look wrong until you know why. Do not "fix" them without reading the comment.

**The cost-recording pool has a deliberately short timeout.** `index.js:60-66`:

> "Deliberately SHORT, unlike the user-facing functions which wait 60s for an Azure SQL
> auto-pause resume. Cost recording runs in this function's finally block, so it sits in
> the critical path of every user query — waiting out a resume here would add that delay
> to every question asked. Losing a cost row is the better trade."

**The user-facing pools wait a full 60 seconds.** `chat-sessions/index.js:30-32`:

> "60s: an Azure SQL serverless database resuming from auto-pause takes ~30-60s. A shorter
> timeout can never wait one out, so the first request after an idle period always failed."

**The query cache refuses any turn with history.** `index.js:1304-1310`:

> "The cache key is (question, database) and carries NO conversation context, so it is only
> sound for a self-contained question. A follow-up such as 'now show me the late ones'
> means something different in every chat."

**Raw-SQL presets are never rewritten by the model.** Three places enforce this —
`index.js:1361`, `index.js:1511`, `index.js:1574`:

> "a preset that legitimately returns zero rows ... must report that zero, not have the
> model rewrite the query to find something."

**`temperature` is only sent to some models.** `index.js:664-666`: "Sonnet 4.6 accepts
temperature; Opus 4.8 removed the sampling parameters ... and returns HTTP 400 if any are
sent."

**Part descriptions must come from `FMUSRMEMO1`, never `FDESCRIPT`.** `index.js:256`:
"FDESCRIPT is a truncated 35-character short version ... NEVER select it as a description,
not even as a fallback."

**The glossary lives inside the schema block, not the instructions.** `index.js:217-218`:
"prepended to the schema in every prompt so it stays inside the prompt-cache window (zero
token cost after first request)."

**Pools are never closed.** `index.js:1664`: "Pool is NOT closed — it's reused across
invocations."

**`input_tokens` in `query_costs` changed meaning.** `index.js:1696-1698`:

> "input_tokens now records ALL billed input (uncached + cache reads + cache writes). Rows
> written before this change hold uncached-only counts, so historical totals understate
> input for the same spend."

**Some `let`s are declared before the `try` on purpose.** `index.js:1151-1153`:

> "Declared out here so the catch block can reference them — otherwise an error in the try
> would make the catch throw its own ReferenceError, producing an empty-body 500."

**Conversation history carries the SQL, not just the prose.** `src/App.tsx:400-403`:

> "so a follow-up that refers to a prior result ('those 1,722 parts', 'that list') can
> reuse the exact query/filter instead of the model re-deriving a different one from the
> prose (which drifts — e.g. 1,722 -> 1,835)."

**Local dev bypasses SSO.** `src/App.tsx:18-20`: "skip the Microsoft SSO gate (redirect
URIs don't resolve on localhost). import.meta.env.DEV is false in every production build."

---

## 7. Known rough edges

Observations only. Nothing here is fixed.

**Dead code, currently.**
- `validateAgainstConstraints` (`index.js:898`) is defined but never called. Its only
  reference in the file is its own definition.
- `constraints` is computed at `index.js:1329` and never read again. The clarifier extracts
  a status; nothing enforces it.
- `checkCostCap` (`index.js:171`) is never called, so `DAILY_USER_COST_LIMIT` and
  `DAILY_GLOBAL_COST_LIMIT` (`index.js:168-169`) have no effect.
- `getCostPoolSafe` (`index.js:80`) is never called, and `getCostPool` (`index.js:44`) is
  only called by it — so the whole cost-pool chain is unreachable. The cost insert in the
  `finally` block builds its own `sql.ConnectionPool` instead (`index.js:1682`).

**The offline test harness does not run.** `eval.js:24` destructures
`parseGeminiResponse` from `_internals`, which no longer exists after the Gemini removal.
`node eval.js --unit` throws `TypeError: parseGeminiResponse is not a function`.
`_internals` (`index.js:1721`) also does not export `parseClaudeResponse`, so there is no
current replacement to point the test at.

**Status handling is inconsistent across three places.**
- The few-shot example at `index.js:352` teaches
  `WHERE RTRIM(FSTATUS) NOT IN ('Closed', 'Cancelled')`, which also admits `On Hold` and
  `Revised`.
- The zero-row retry at `index.js:1584` instructs the model: "don't filter by status unless
  the user specifically asked for a status", and at `index.js:1586`: "remove unnecessary
  status filters."
- `KNOWN_STATUSES` (`index.js:36`) lists `Open, Closed, Cancelled, On Hold, Revised`, but
  the FSTATUS explainer at `index.js:358` tells users a value `'Started'` exists.

**The semantic critic's status branch cannot fire.** `index.js:943-949`. The outer `if`
passes when the SQL has no status filter, but the inner `if` only pushes an issue when
there is no `WHERE` clause at all. A query with a `WHERE` that ignores status falls through
silently. The comment at `index.js:945` describes the opposite behavior.

**`validateAgainstConstraints` scans the whole SQL for `STATUS`.** `index.js:904` tests
`upperSql.includes('STATUS')`, which a display alias in the `SELECT` list (for example
`AS "Order Status"`) would satisfy without any filter being present.

**A preset filters on a status value that may not exist.** `src/App.tsx:989` uses
`WHERE fstatus = 'O'`. Elsewhere the codebase treats FSTATUS values as whole words
(`'Open'`, `'Closed'`). TODO: verify — whether `SOMAST.FSTATUS` ever holds a single
character `'O'`, or whether this preset silently returns zero.

**Connection-string parsing is copy-pasted eight times.** The same ~8-line split loop
appears at `m2m-query/index.js:48`, `:103`, `:1676`, `chat-sessions/index.js:17`,
`chat-messages/index.js:18`, `query-costs/index.js:17`, `activity-report/index.js:24`, and
in `shared/db.js`. Only the last is shared. Relatedly, `shared/db.js` is half adopted:
`m2m-status` and `open-po-overseas` use `withQuery`, while `m2m-query` keeps its own
`getDbPool` (`index.js:99`) doing the same job.

**A nested duplicate function folder exists.**
`azure-functions/m2m-status/m2m-status/index.js` is a second, different copy of the
m2m-status handler (198 lines versus 163). TODO: verify — which copy Azure actually serves.

**ERP pools disable encryption; app pools require it.** `index.js:115` sets
`{ encrypt: false, trustServerCertificate: true }` for the ERP and UniPoint connections,
while `index.js:59` and the chat functions set `{ encrypt: true }`.

**CORS is fully open.** Every function returns `'Access-Control-Allow-Origin': '*'`, for
example `index.js:1132`. Access control rests on the `?code=` function key and the
frontend's own MSAL gate.

**Authorization for company access is client-side only.** `MULTI_COMPANY_USERS`
(`src/App.tsx:95`) decides which databases a user can pick, in the browser. The backend
accepts whatever `database` value is posted (`index.js:1212`) without checking the caller.

**Four separate hardcoded people-lists.** `MULTI_COMPANY_USERS` (`src/App.tsx:95`),
`ADMIN_EMAILS` (`src/App.tsx:51`), `ALUMINUM_PRESET_USERS` (`src/App.tsx:54`), and
`ACTIVITY_VIEWERS` (`activity-report/index.js:15`). Adding a person means editing more
than one file.

**Gemini naming survives the removal.** The variable `geminiCalls` (`index.js:1150`) and
the column `gemini_calls` (`schema.sql`) both now count Claude calls. `index.js:130` still
describes the cache as avoiding "redundant Gemini calls."

**`README.md` is the unmodified Vite starter template.** `DECISIONS.md`, `DEBT.md`, and a
happy-path smoke test are absent.

**Eight deployed function folders are untracked in git** (listed in section 2).
`deploy.ps1` zips them, so production runs code that is not under version control.

**`check.ps1` points at a path that no longer exists** — `c:\Users\ajimenez\Downloads\MAC-PP-main\MAC-PP-main\...`.

**Three schema files exist for the same database:** `m2m_schema.txt` (root, 1.1 MB),
`azure-functions/m2m-schema.txt`, `azure-functions/m2m-schema-slim.txt`, and an untracked
`azure-functions/m2m-schema-ultra-slim.txt`. Only `m2m-schema-slim.txt` is read at runtime
(`index.js:200`).
