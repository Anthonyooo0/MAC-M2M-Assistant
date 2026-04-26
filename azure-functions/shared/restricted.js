// Single source of truth for tables and columns that must NEVER be queried,
// referenced in prompts, or shown in the Query Builder picker.
//
// Used by:
//   - m2m-query/index.js (validateSqlSafety + prompt block)
//   - schema-meta/index.js (filter picker output)

const RESTRICTED_TABLES = [
  // M2M — HR, Payroll & Labor
  'PREMPL', 'CSPAYR', 'PRDIST', 'PRDEPT', 'CRHEAD', 'CRMAST',
  'LADETAIL', 'LADETAILVIEW', 'LAMAST',
  // M2M — Banking & EFT
  'APCHAC', 'APEFTMAST', 'VENDEFT', 'CCINFO', 'CCSETUPMAST',
  // M2M — System Security
  'UTUSER', 'UTPASSWD', 'UTPREF',
  // M2M — Corporate Financials
  'GLMAST', 'GLITEM', 'GLSTMT', 'PLBUDG',
  // UniPoint — Security & PII
  'PT_SECURITY_USERS', 'PT_EMPLOYEE', 'PT_EMPLOYEE_EXTENDED', 'PT_GST',
];

// Wildcard rule — matches PT_Cashflow, PT_Cashflow_Detail, etc.
const RESTRICTED_TABLE_PATTERNS = [
  /^PT_CASHFLOW\w*$/i,
];

// Format: { TABLE_NAME: ['COL1', 'COL2'] } — scoped per-table for clarity.
// In SQL safety check we only need the column-name list; in the picker we
// filter by (table, column) pair so unrelated tables aren't affected.
const RESTRICTED_COLUMNS_BY_TABLE = {
  INPROD: ['FCOGSLAB', 'FCOGSMATL', 'FCOGSOVHD'],
  SOANAL: [
    'FNGRSPFT01', 'FNGRSPFT02', 'FNGRSPFT03', 'FNGRSPFT04',
    'FNGRSPFT05', 'FNGRSPFT06', 'FNGRSPFT07', 'FNGRSPFT08',
    'FNGRSPFT09', 'FNGRSPFT10', 'FNGRSPFT11', 'FNGRSPFT12',
  ],
  JOPACT: ['FLABACT', 'FMATLACT', 'FOTHRACT'],
  BLQOC: ['FNBLPROFIT', 'FNQUPROFIT'],
  BLQOP: ['FNBLPROFIT', 'FNQUPROFIT'],
};

// Flat list — used by validateSqlSafety regex check (table-agnostic).
const RESTRICTED_COLUMNS_FLAT = Array.from(
  new Set(Object.values(RESTRICTED_COLUMNS_BY_TABLE).flat())
);

function isTableRestricted(tableName) {
  if (!tableName) return false;
  const upper = tableName.toUpperCase();
  if (RESTRICTED_TABLES.includes(upper)) return true;
  return RESTRICTED_TABLE_PATTERNS.some(re => re.test(upper));
}

function isColumnRestricted(tableName, columnName) {
  if (!tableName || !columnName) return false;
  const cols = RESTRICTED_COLUMNS_BY_TABLE[tableName.toUpperCase()];
  if (!cols) return false;
  return cols.includes(columnName.toUpperCase());
}

module.exports = {
  RESTRICTED_TABLES,
  RESTRICTED_TABLE_PATTERNS,
  RESTRICTED_COLUMNS_BY_TABLE,
  RESTRICTED_COLUMNS_FLAT,
  isTableRestricted,
  isColumnRestricted,
};
