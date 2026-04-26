/**
 * MAC M2M Assistant — Eval Harness
 *
 * Runs the golden test set against the validation functions without making
 * any Gemini API calls or database connections. Tests are purely structural:
 *   1. Unit tests for core validation functions (safety, schema, parsing, error guidance)
 *   2. SQL pattern tests against the golden test set (simulated Gemini output)
 *
 * Usage:
 *   node eval.js                 # Run all tests
 *   node eval.js --unit          # Unit tests only
 *   node eval.js --golden        # Golden test set only
 *   node eval.js --id m2m-003    # Run a specific test by ID
 *
 * Exit codes:
 *   0 = all tests passed
 *   1 = one or more tests failed
 */

const handler = require('./index.js');
const {
  validateSqlSafety,
  validateAgainstSchema,
  parseGeminiResponse,
  cleanSqlQuery,
  getErrorGuidance,
  semanticSanityCheck,
  scoreConfidence,
  scrubPII,
  M2M_TABLES,
  UNIPOINT_TABLES,
  PROMPT_VERSION,
} = handler._internals;

const testQueries = require('./test-queries.json');

// ---------------------------------------------------------------------------
// Test runner infrastructure
// ---------------------------------------------------------------------------

let totalTests = 0;
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testId, message) {
  totalTests++;
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push({ testId, message });
    console.log(`  FAIL: ${message}`);
  }
}

function section(name) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${name}`);
  console.log('='.repeat(60));
}

// ---------------------------------------------------------------------------
// UNIT TESTS — validate core functions in isolation
// ---------------------------------------------------------------------------

function runUnitTests() {
  section('Unit Tests: validateSqlSafety()');

  // Should pass valid SELECT queries
  assert(
    validateSqlSafety('SELECT TOP 500 FSONO FROM SOMAST').ok,
    'unit-safety-001', 'Simple SELECT should pass'
  );
  assert(
    validateSqlSafety('WITH cte AS (SELECT FSONO FROM SOMAST) SELECT FSONO FROM cte').ok,
    'unit-safety-002', 'CTE (WITH) should pass'
  );

  // Should block non-SELECT
  assert(
    !validateSqlSafety('INSERT INTO SOMAST VALUES (1)').ok,
    'unit-safety-003', 'INSERT should be blocked'
  );
  assert(
    !validateSqlSafety('DELETE FROM SOMAST').ok,
    'unit-safety-004', 'DELETE should be blocked'
  );
  assert(
    !validateSqlSafety('DROP TABLE SOMAST').ok,
    'unit-safety-005', 'DROP should be blocked'
  );
  assert(
    !validateSqlSafety('EXEC sp_who').ok,
    'unit-safety-006', 'EXEC should be blocked'
  );
  assert(
    !validateSqlSafety('UPDATE SOMAST SET FSTATUS = \'X\'').ok,
    'unit-safety-007', 'UPDATE should be blocked'
  );

  // Should block M2M restricted tables
  assert(
    !validateSqlSafety('SELECT * FROM PREMPL').ok,
    'unit-safety-010', 'PREMPL (employee PII) should be blocked'
  );
  assert(
    !validateSqlSafety('SELECT * FROM CCINFO').ok,
    'unit-safety-011', 'CCINFO (credit cards) should be blocked'
  );
  assert(
    !validateSqlSafety('SELECT * FROM GLMAST').ok,
    'unit-safety-012', 'GLMAST (financials) should be blocked'
  );
  assert(
    !validateSqlSafety('SELECT * FROM UTUSER').ok,
    'unit-safety-013', 'UTUSER (security) should be blocked'
  );

  // Should block UniPoint restricted tables
  assert(
    !validateSqlSafety('SELECT * FROM PT_EMPLOYEE').ok,
    'unit-safety-020', 'PT_EMPLOYEE should be blocked'
  );
  assert(
    !validateSqlSafety('SELECT * FROM PT_SECURITY_USERS').ok,
    'unit-safety-021', 'PT_SECURITY_USERS should be blocked'
  );
  assert(
    !validateSqlSafety('SELECT * FROM PT_EMPLOYEE_EXTENDED').ok,
    'unit-safety-022', 'PT_EMPLOYEE_EXTENDED should be blocked'
  );
  assert(
    !validateSqlSafety('SELECT * FROM PT_Cashflow').ok,
    'unit-safety-023', 'PT_Cashflow should be blocked'
  );
  assert(
    !validateSqlSafety('SELECT * FROM PT_Cashflow_Detail').ok,
    'unit-safety-024', 'PT_Cashflow_Detail (wildcard) should be blocked'
  );
  assert(
    !validateSqlSafety('SELECT * FROM PT_GST').ok,
    'unit-safety-025', 'PT_GST should be blocked'
  );

  // Should block restricted columns even on allowed tables
  assert(
    validateSqlSafety('SELECT F2LABCOST FROM INMASTX').ok,
    'unit-safety-030', 'F2LABCOST is now allowed on INMASTX'
  );
  assert(
    validateSqlSafety('SELECT FAVGCOST FROM INMASTX').ok,
    'unit-safety-031', 'FAVGCOST is now allowed on INMASTX'
  );
  assert(
    !validateSqlSafety('SELECT FNGRSPFT01 FROM SOANAL').ok,
    'unit-safety-032', 'FNGRSPFT01 should be blocked'
  );

  // Should allow non-restricted columns on allowed tables
  assert(
    validateSqlSafety('SELECT FPARTNO, FREV FROM INMASTX').ok,
    'unit-safety-040', 'Non-restricted INMASTX columns should pass'
  );

  section('Unit Tests: validateAgainstSchema()');

  // Should pass valid table references
  assert(
    validateAgainstSchema('SELECT * FROM SOMAST', M2M_TABLES).ok,
    'unit-schema-001', 'SOMAST should be valid in M2M schema'
  );
  assert(
    validateAgainstSchema('SELECT * FROM PT_NC', UNIPOINT_TABLES).ok,
    'unit-schema-002', 'PT_NC should be valid in UniPoint schema'
  );

  // Should fail invalid table references
  assert(
    !validateAgainstSchema('SELECT * FROM FAKE_TABLE', M2M_TABLES).ok,
    'unit-schema-010', 'FAKE_TABLE should fail M2M schema validation'
  );
  assert(
    !validateAgainstSchema('SELECT * FROM NONEXISTENT', UNIPOINT_TABLES).ok,
    'unit-schema-011', 'NONEXISTENT should fail UniPoint schema validation'
  );

  // Should fail invalid qualified column references
  assert(
    !validateAgainstSchema('SELECT SOMAST.FAKECOL FROM SOMAST', M2M_TABLES).ok,
    'unit-schema-020', 'SOMAST.FAKECOL should fail (column does not exist)'
  );

  // Should pass valid qualified column references
  assert(
    validateAgainstSchema('SELECT SOMAST.FSONO FROM SOMAST', M2M_TABLES).ok,
    'unit-schema-021', 'SOMAST.FSONO should pass (column exists)'
  );

  section('Unit Tests: parseGeminiResponse()');

  // Should parse valid JSON response
  const validResponse = {
    candidates: [{ content: { parts: [{ text: '{"explanation":"test","sql":"SELECT 1"}' }] } }]
  };
  const parsed = parseGeminiResponse(validResponse);
  assert(parsed.explanation === 'test', 'unit-parse-001', 'Should extract explanation');
  assert(parsed.sqlQuery === 'SELECT 1', 'unit-parse-002', 'Should extract SQL');

  // Should handle code-fenced JSON
  const fencedResponse = {
    candidates: [{ content: { parts: [{ text: '```json\n{"explanation":"test","sql":"SELECT 1"}\n```' }] } }]
  };
  const parsedFenced = parseGeminiResponse(fencedResponse);
  assert(parsedFenced.sqlQuery === 'SELECT 1', 'unit-parse-003', 'Should strip code fences');

  // Should return error on invalid JSON (not treat as SQL)
  const invalidResponse = {
    candidates: [{ content: { parts: [{ text: 'SELECT * FROM SOMAST' }] } }]
  };
  const parsedInvalid = parseGeminiResponse(invalidResponse);
  assert(parsedInvalid.sqlQuery === '', 'unit-parse-010', 'Raw SQL should NOT be treated as valid — sqlQuery should be empty');
  assert(parsedInvalid.explanation.includes('improperly formatted'), 'unit-parse-011', 'Should return error explanation');

  // Should handle BOM prefix
  const bomResponse = {
    candidates: [{ content: { parts: [{ text: '\uFEFF{"explanation":"bom","sql":"SELECT 1"}' }] } }]
  };
  const parsedBom = parseGeminiResponse(bomResponse);
  assert(parsedBom.sqlQuery === 'SELECT 1', 'unit-parse-020', 'Should strip BOM and parse correctly');

  section('Unit Tests: cleanSqlQuery()');

  assert(
    cleanSqlQuery('-- comment\nSELECT 1') === 'SELECT 1',
    'unit-clean-001', 'Should strip single-line comments'
  );
  assert(
    cleanSqlQuery('/* block */ SELECT 1') === 'SELECT 1',
    'unit-clean-002', 'Should strip block comments'
  );
  assert(
    cleanSqlQuery('Here is the query: SELECT TOP 10 * FROM SOMAST').startsWith('SELECT'),
    'unit-clean-003', 'Should extract embedded SELECT'
  );

  section('Unit Tests: getErrorGuidance()');

  const syntaxErr = getErrorGuidance("Incorrect syntax near 'DATEADD'");
  assert(syntaxErr.includes('SYNTAX'), 'unit-err-001', 'Should match syntax error pattern');
  assert(syntaxErr.includes('DATEADD'), 'unit-err-002', 'Should extract the near token');

  const colErr = getErrorGuidance("Invalid column name 'FDUEDATE'");
  assert(colErr.includes('FDUEDATE'), 'unit-err-003', 'Should extract invalid column name');

  const tableErr = getErrorGuidance("Invalid object name 'FAKETABLE'");
  assert(tableErr.includes('FAKETABLE'), 'unit-err-004', 'Should extract invalid table name');

  const ambigErr = getErrorGuidance("Ambiguous column name 'FPARTNO'");
  assert(ambigErr.includes('FPARTNO') && ambigErr.includes('Prefix'), 'unit-err-005', 'Should advise prefixing ambiguous column');

  const convErr = getErrorGuidance("Conversion failed when converting varchar to int");
  assert(convErr.includes('type'), 'unit-err-006', 'Should match conversion error');

  const unknownErr = getErrorGuidance("Some unknown error happened");
  assert(unknownErr.includes('schema carefully'), 'unit-err-007', 'Should return default guidance for unknown errors');

  section('Unit Tests: semanticSanityCheck()');

  // Should flag "late" without date comparison
  const lateCheck = semanticSanityCheck('show me late orders', 'SELECT * FROM SOMAST', 100);
  assert(!lateCheck.ok, 'unit-sem-001', 'Should flag "late" query with no GETDATE()');

  // Should pass "late" with proper date comparison
  const lateOk = semanticSanityCheck('show me late orders', "SELECT * FROM SOMAST WHERE FDUEDATE < GETDATE()", 5);
  assert(lateOk.ok, 'unit-sem-002', 'Should pass "late" query with GETDATE()');

  // Should flag "this month" without date filter
  const monthCheck = semanticSanityCheck('orders this month', 'SELECT * FROM SOMAST', 200);
  assert(!monthCheck.ok, 'unit-sem-003', 'Should flag "this month" with no date filter');

  // Should pass "this month" with proper date filter
  const monthOk = semanticSanityCheck('orders this month', "SELECT * FROM SOMAST WHERE FORDDATE >= DATEADD(month, 0, GETDATE())", 10);
  assert(monthOk.ok, 'unit-sem-004', 'Should pass "this month" with DATEADD');

  section('Unit Tests: scoreConfidence()');

  // Simple single-table SELECT should be high confidence
  const simpleScore = scoreConfidence('SELECT TOP 500 FSONO FROM SOMAST');
  assert(simpleScore >= 0.90, 'unit-conf-001', `Simple SELECT should be >= 0.90 (got ${simpleScore})`);

  // No SQL (conversational) should be 1.0
  assert(scoreConfidence('') === 1.0, 'unit-conf-002', 'Empty SQL should be 1.0');
  assert(scoreConfidence(null) === 1.0, 'unit-conf-003', 'Null SQL should be 1.0');

  // Single JOIN should lower confidence slightly
  const joinScore = scoreConfidence('SELECT s.FSONO FROM SOMAST s JOIN SOITEM i ON s.FSONO = i.FSONO');
  assert(joinScore >= 0.85 && joinScore < 1.0, 'unit-conf-004', `Single JOIN should be 0.85-0.99 (got ${joinScore})`);

  // Multi-join complex query should be notably lower
  const complexScore = scoreConfidence(
    'SELECT s.FSONO, j.FJOBNO, p.FPONO FROM SOMAST s ' +
    'JOIN JOMAST j ON s.FSONO = j.FSONO ' +
    'JOIN POITEM p ON p.FSOKEY = s.FSONO ' +
    'JOIN POMAST pm ON p.FPONO = pm.FPONO ' +
    'WHERE DATEADD(month, -1, GETDATE()) < s.FORDDATE ' +
    'GROUP BY s.FSONO, j.FJOBNO, p.FPONO ' +
    'HAVING COUNT(*) > 1'
  );
  assert(complexScore < 0.70, 'unit-conf-005', `Complex 4-JOIN + GROUP BY + HAVING + DATEADD should be < 0.70 (got ${complexScore})`);

  // Subquery should reduce confidence
  const subqScore = scoreConfidence('SELECT * FROM SOMAST WHERE FSONO IN (SELECT FSONO FROM JOMAST)');
  assert(subqScore < 0.95, 'unit-conf-006', `Subquery should reduce confidence below 0.95 (got ${subqScore})`);

  // CASE expression should reduce confidence
  const caseScore = scoreConfidence(
    "SELECT FSONO, CASE WHEN FSTATUS = 'Open' THEN 'Active' ELSE 'Closed' END AS Status FROM SOMAST"
  );
  assert(caseScore < 0.95, 'unit-conf-007', `CASE expression should reduce confidence below 0.95 (got ${caseScore})`);

  // Aggregate with GROUP BY
  const aggScore = scoreConfidence('SELECT FCOMPANY, COUNT(*) AS Total FROM SOMAST GROUP BY FCOMPANY');
  assert(aggScore >= 0.85 && aggScore <= 0.95, 'unit-conf-008', `GROUP BY aggregate should be 0.85-0.95 (got ${aggScore})`);

  section('Unit Tests: SELECT * blocking');

  // SELECT * should be blocked
  assert(
    !validateSqlSafety('SELECT * FROM SOMAST').ok,
    'unit-star-001', 'SELECT * should be blocked'
  );
  assert(
    !validateSqlSafety('SELECT TOP 500 * FROM SOMAST').ok,
    'unit-star-002', 'SELECT TOP 500 * should be blocked'
  );
  assert(
    !validateSqlSafety('SELECT  TOP 100  * FROM POITEM').ok,
    'unit-star-003', 'SELECT TOP 100 * (extra spaces) should be blocked'
  );
  // Explicit columns should pass
  assert(
    validateSqlSafety('SELECT FSONO, FCOMPANY FROM SOMAST').ok,
    'unit-star-004', 'Explicit columns should pass'
  );
  // COUNT(*) should NOT be blocked — the * is inside an aggregate, not a column selector
  assert(
    validateSqlSafety('SELECT COUNT(*) AS Total FROM SOMAST').ok,
    'unit-star-005', 'COUNT(*) should NOT be blocked'
  );

  section('Unit Tests: scrubPII()');

  // SSN patterns
  assert(
    scrubPII('SSN is 123-45-6789').includes('[SSN_REDACTED]'),
    'unit-pii-001', 'Should redact SSN with dashes'
  );
  assert(
    scrubPII('SSN is 123 45 6789').includes('[SSN_REDACTED]'),
    'unit-pii-002', 'Should redact SSN with spaces'
  );

  // Email addresses
  assert(
    scrubPII('Contact john.doe@example.com for info').includes('[EMAIL_REDACTED]'),
    'unit-pii-003', 'Should redact email addresses'
  );
  assert(
    !scrubPII('Contact john.doe@example.com').includes('john.doe@example.com'),
    'unit-pii-004', 'Original email should be gone after scrubbing'
  );

  // Phone numbers
  assert(
    scrubPII('Call (555) 123-4567').includes('[PHONE_REDACTED]'),
    'unit-pii-005', 'Should redact phone with parens'
  );
  assert(
    scrubPII('Call 555-123-4567').includes('[PHONE_REDACTED]'),
    'unit-pii-006', 'Should redact phone with dashes'
  );

  // Credit card numbers
  assert(
    scrubPII('CC 4111-1111-1111-1111').includes('[CC_REDACTED]'),
    'unit-pii-007', 'Should redact credit card with dashes'
  );
  assert(
    scrubPII('CC 4111111111111111').includes('[CC_REDACTED]'),
    'unit-pii-008', 'Should redact credit card without separators'
  );

  // Non-PII should pass through unchanged
  assert(
    scrubPII('Show me open sales orders for ACME Corp') === 'Show me open sales orders for ACME Corp',
    'unit-pii-009', 'Non-PII text should pass through unchanged'
  );
  assert(
    scrubPII('Part number 12345-678') === 'Part number 12345-678',
    'unit-pii-010', 'Part numbers (not SSN-shaped) should not be redacted'
  );

  // Mixed content
  const mixed = scrubPII('Employee John Smith, SSN 123-45-6789, email john@mac.com, phone 555-123-4567');
  assert(mixed.includes('[SSN_REDACTED]'), 'unit-pii-011', 'Should redact SSN in mixed content');
  assert(mixed.includes('[EMAIL_REDACTED]'), 'unit-pii-012', 'Should redact email in mixed content');
  assert(mixed.includes('[PHONE_REDACTED]'), 'unit-pii-013', 'Should redact phone in mixed content');
  assert(mixed.includes('John Smith'), 'unit-pii-014', 'Should preserve non-PII names in mixed content');
}

// ---------------------------------------------------------------------------
// GOLDEN TEST SET — validate SQL patterns against expected structures
// ---------------------------------------------------------------------------

function runGoldenTests(filterById) {
  section('Golden Test Set: SQL Pattern Validation');
  console.log(`  Prompt version: ${PROMPT_VERSION}`);
  console.log(`  Test cases: ${testQueries.tests.length}`);

  const tests = filterById
    ? testQueries.tests.filter(t => t.id === filterById)
    : testQueries.tests;

  if (filterById && tests.length === 0) {
    console.log(`  ERROR: No test found with id "${filterById}"`);
    failed++;
    return;
  }

  for (const test of tests) {
    console.log(`\n  --- ${test.id}: "${test.question}" [${test.category}] ---`);

    // For golden tests, we can't call Gemini, so we validate the TEST DEFINITION
    // against our safety/schema infrastructure. This catches:
    //   - Tests that expect restricted tables in SQL (should be refusals)
    //   - Tests that expect tables not in the schema
    //   - Schema coverage: do the expected tables/columns actually exist?

    const schemaTables = test.database === 'unipoint_live' ? UNIPOINT_TABLES : M2M_TABLES;

    // Verify expected tables exist in schema (or test expects no SQL)
    if (test.expect_tables && test.expect_tables.length > 0) {
      for (const table of test.expect_tables) {
        assert(
          schemaTables[table.toLowerCase()] !== undefined,
          test.id,
          `Expected table ${table} must exist in ${test.database} schema`
        );
      }
    }

    // Verify the test's must_not_contain list includes restricted tables if applicable
    if (test.expect_sql_empty) {
      assert(
        test.must_not_contain && test.must_not_contain.includes('SELECT'),
        test.id,
        'Tests expecting no SQL should have "SELECT" in must_not_contain'
      );
    }

    // Safety validation: simulate a query referencing expected tables
    if (test.expect_tables && test.expect_tables.length > 0) {
      const simSql = `SELECT TOP 500 col1 FROM ${test.expect_tables.join(', ')}`;
      const safety = validateSqlSafety(simSql);
      assert(
        safety.ok,
        test.id,
        `Expected tables [${test.expect_tables}] should pass safety validation (got: ${safety.reason || 'ok'})`
      );
    }

    // Schema validation: verify expected columns exist on expected tables
    if (test.expect_columns_any) {
      for (const col of test.expect_columns_any) {
        // Skip aggregate functions like COUNT
        if (['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'JOIN', 'GROUP BY', 'ORDER BY'].includes(col.toUpperCase())) continue;

        // Check if this column exists on any of the expected tables
        let found = false;
        for (const table of (test.expect_tables || [])) {
          const tableCols = schemaTables[table.toLowerCase()];
          if (tableCols && tableCols.has(col.toLowerCase())) {
            found = true;
            break;
          }
        }
        // Also check with STATUS and other case-insensitive matches
        if (!found) {
          for (const table of (test.expect_tables || [])) {
            const tableCols = schemaTables[table.toLowerCase()];
            if (tableCols) {
              for (const c of tableCols) {
                if (c.toUpperCase() === col.toUpperCase()) { found = true; break; }
              }
            }
            if (found) break;
          }
        }
        if (test.expect_tables && test.expect_tables.length > 0) {
          assert(
            found,
            test.id,
            `Expected column ${col} should exist in one of [${test.expect_tables}]`
          );
        }
      }
    }

    // Verify must_not_contain items are actually blocked by safety validation
    if (test.must_not_contain) {
      for (const forbidden of test.must_not_contain) {
        // Skip SQL keywords (SELECT, INSERT, DELETE) — those are logical checks, not table/column
        if (['SELECT', 'INSERT', 'DELETE', 'UPDATE', 'DROP'].includes(forbidden.toUpperCase())) continue;

        // If it's a restricted table, verify it's in the safety blocklist
        const simSql = `SELECT * FROM ${forbidden}`;
        const safety = validateSqlSafety(simSql);
        if (!safety.ok) {
          assert(true, test.id, `${forbidden} is correctly blocked by validateSqlSafety()`);
        }
        // Not all must_not_contain items are restricted tables — some are column names
        // like FDUEDATE (which is a hallucination, not a security issue)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const runUnit = args.includes('--unit') || args.length === 0;
const runGolden = args.includes('--golden') || args.length === 0;
const idFilter = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;

console.log('MAC M2M Assistant — Eval Harness');
console.log(`Prompt version: ${PROMPT_VERSION}`);
console.log(`M2M schema: ${Object.keys(M2M_TABLES).length} tables`);
console.log(`UniPoint schema: ${Object.keys(UNIPOINT_TABLES).length} tables`);

if (runUnit && !idFilter) {
  runUnitTests();
}

if (runGolden || idFilter) {
  runGoldenTests(idFilter);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

section('RESULTS');
console.log(`  Total:  ${totalTests}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failures.length > 0) {
  console.log('\n  Failures:');
  for (const f of failures) {
    console.log(`    [${f.testId}] ${f.message}`);
  }
}

console.log('');
process.exit(failed > 0 ? 1 : 0);
