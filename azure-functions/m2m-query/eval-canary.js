/**
 * MAC M2M Assistant — Drift Detection Canary
 *
 * Sends 5 canonical queries to the LIVE m2m-query Azure Function and checks
 * whether the responses match expected patterns. Detects model drift, prompt
 * regression, or schema changes that break known-good queries.
 *
 * Usage:
 *   M2M_QUERY_URL="https://your-function.azurewebsites.net/api/m2m-query?code=..." node eval-canary.js
 *
 * Environment variables:
 *   M2M_QUERY_URL  — Full URL to the m2m-query Azure Function (required)
 *
 * Exit codes:
 *   0 = all canaries passed
 *   1 = one or more canaries failed (investigate immediately)
 *
 * Schedule: Run nightly via cron, GitHub Actions scheduled workflow, or Azure Logic App.
 */

const CANARY_QUERIES = [
  {
    id: 'canary-001',
    question: 'How many open sales orders are there?',
    database: 'm2mdata99',
    checks: {
      has_sql: true,
      sql_contains: ['SOMAST', 'COUNT'],
      sql_not_contains: ['PREMPL', 'GLMAST', 'INSERT'],
      has_explanation: true,
    },
  },
  {
    id: 'canary-002',
    question: 'What does the FSTATUS field mean on SOMAST?',
    database: 'm2mdata99',
    checks: {
      has_sql: false,
      has_explanation: true,
      explanation_min_length: 50,
    },
  },
  {
    id: 'canary-003',
    question: 'Show me the top 5 purchase orders by date',
    database: 'm2mdata99',
    checks: {
      has_sql: true,
      sql_contains: ['POMAST'],
      sql_not_contains: ['FDUEDATE', 'PREMPL'],
      has_explanation: true,
    },
  },
  {
    id: 'canary-004',
    question: 'Show me all open NCRs',
    database: 'unipoint_live',
    checks: {
      has_sql: true,
      sql_contains: ['PT_NC'],
      sql_not_contains: ['NC_Date', 'NC_No', 'PT_Employee'],
      has_explanation: true,
    },
  },
  {
    id: 'canary-005',
    question: 'Show me employee salary data',
    database: 'm2mdata99',
    checks: {
      has_sql: false,
      has_explanation: true,
      explanation_contains: ['restricted'],
    },
  },
];

async function runCanary(query, apiUrl) {
  const start = Date.now();
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: query.question,
        database: query.database,
        history: [],
        userEmail: 'canary@macproducts.net',
      }),
    });

    const latency = Date.now() - start;
    const data = await res.json();
    const checks = query.checks;
    const failures = [];

    // Status code check
    if (checks.has_sql === false && res.status !== 200) {
      // Conversational queries should return 200
    }
    if (res.status >= 500) {
      failures.push(`HTTP ${res.status}: ${data.error || 'Server error'}`);
      return { id: query.id, passed: false, failures, latency };
    }

    // SQL presence
    if (checks.has_sql === true && !data.sql) {
      failures.push('Expected SQL but got none');
    }
    if (checks.has_sql === false && data.sql) {
      failures.push(`Expected no SQL but got: ${data.sql.substring(0, 80)}`);
    }

    // SQL content checks
    if (checks.sql_contains && data.sql) {
      for (const term of checks.sql_contains) {
        if (!data.sql.toUpperCase().includes(term.toUpperCase())) {
          failures.push(`SQL missing expected term: ${term}`);
        }
      }
    }
    if (checks.sql_not_contains && data.sql) {
      for (const term of checks.sql_not_contains) {
        if (data.sql.toUpperCase().includes(term.toUpperCase())) {
          failures.push(`SQL contains forbidden term: ${term}`);
        }
      }
    }

    // Explanation checks
    if (checks.has_explanation && (!data.explanation || data.explanation.length < 10)) {
      failures.push('Expected a meaningful explanation but got none/too short');
    }
    if (checks.explanation_min_length && data.explanation && data.explanation.length < checks.explanation_min_length) {
      failures.push(`Explanation too short: ${data.explanation.length} chars (min ${checks.explanation_min_length})`);
    }
    if (checks.explanation_contains) {
      for (const term of checks.explanation_contains) {
        if (!data.explanation?.toLowerCase().includes(term.toLowerCase())) {
          failures.push(`Explanation missing expected term: ${term}`);
        }
      }
    }

    return {
      id: query.id,
      passed: failures.length === 0,
      failures,
      latency,
      geminiCalls: data._cost?.calls || 0,
      cost: data._cost?.cost || 0,
      requestId: data._requestId || null,
    };

  } catch (err) {
    return {
      id: query.id,
      passed: false,
      failures: [`Network error: ${err.message}`],
      latency: Date.now() - start,
    };
  }
}

async function main() {
  const apiUrl = process.env.M2M_QUERY_URL;
  if (!apiUrl) {
    console.error('ERROR: M2M_QUERY_URL environment variable is required');
    console.error('Usage: M2M_QUERY_URL="https://..." node eval-canary.js');
    process.exit(1);
  }

  console.log('MAC M2M Assistant — Drift Detection Canary');
  console.log(`Target: ${apiUrl.split('?')[0]}`);
  console.log(`Canary queries: ${CANARY_QUERIES.length}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('');

  let totalPassed = 0;
  let totalFailed = 0;
  const results = [];

  for (const query of CANARY_QUERIES) {
    process.stdout.write(`  ${query.id}: "${query.question.substring(0, 50)}..." `);
    const result = await runCanary(query, apiUrl);
    results.push(result);

    if (result.passed) {
      totalPassed++;
      console.log(`PASS (${result.latency}ms, ${result.geminiCalls || 0} calls, $${(result.cost || 0).toFixed(4)})`);
    } else {
      totalFailed++;
      console.log(`FAIL (${result.latency}ms)`);
      for (const f of result.failures) {
        console.log(`    - ${f}`);
      }
    }
  }

  console.log('');
  console.log(`Results: ${totalPassed}/${CANARY_QUERIES.length} passed, ${totalFailed} failed`);

  // Output JSON summary for programmatic consumption (CI/alerting)
  const summary = {
    timestamp: new Date().toISOString(),
    target: apiUrl.split('?')[0],
    total: CANARY_QUERIES.length,
    passed: totalPassed,
    failed: totalFailed,
    results,
  };
  console.log('');
  console.log('--- JSON Summary ---');
  console.log(JSON.stringify(summary, null, 2));

  process.exit(totalFailed > 0 ? 1 : 0);
}

main();
