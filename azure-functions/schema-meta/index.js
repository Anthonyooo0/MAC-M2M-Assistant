const fs = require('fs');
const path = require('path');
const {
  isTableRestricted,
  isColumnRestricted,
} = require('../shared/restricted');

// Parses a schema file in the slim format used by m2m-query:
//
//   ## TABLENAME — Table description (optional)
//     COLNAME (Type N) — Column description (optional)
//     COLNAME (Type N)
//
// Returns: [{ name, description, columns: [{ name, description, type }] }]
//
// Tables and columns flagged as restricted in shared/restricted.js are removed.
// Columns without a description are kept but use a humanized fallback so the
// picker never shows a raw uppercase F-prefix field name.
function parseSchema(text) {
  const lines = text.split(/\r?\n/);
  const tables = [];
  let current = null;

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#') && !raw.startsWith('## ')) {
      continue;
    }

    if (raw.startsWith('## ')) {
      const headerMatch = raw.match(/^##\s+(\S+)(?:\s+—\s+(.+))?\s*$/);
      if (!headerMatch) continue;
      const tableName = headerMatch[1];
      const tableDesc = (headerMatch[2] || '').trim();

      if (isTableRestricted(tableName)) {
        current = null;
        continue;
      }

      current = {
        name: tableName,
        description: tableDesc || humanize(tableName),
        columns: [],
      };
      tables.push(current);
      continue;
    }

    if (!current) continue;

    const colMatch = raw.match(/^\s+(\S+)\s+\(([^)]+)\)(?:\s+—\s+(.+))?\s*$/);
    if (!colMatch) continue;

    const colName = colMatch[1];
    const colType = colMatch[2].trim();
    const rawDesc = (colMatch[3] || '').trim();

    if (isColumnRestricted(current.name, colName)) continue;

    current.columns.push({
      name: colName,
      description: rawDesc ? cleanColumnDesc(rawDesc) : humanize(colName),
      type: colType,
    });
  }

  return tables;
}

// Schema column descriptions often pack a short label followed by a long
// rambling note, e.g. "PART NUMBER Inventory Part Number". Take the first
// natural fragment as the user-facing label.
function cleanColumnDesc(desc) {
  const firstLine = desc.split(/[.\n]/)[0].trim();
  if (firstLine.length <= 60) return firstLine;
  return firstLine.slice(0, 57).trimEnd() + '...';
}

// Strip leading F prefix and convert to title case for fields without a
// description in the schema. e.g., FCUSTNO -> "Fcustno", SUBJECT -> "Subject"
function humanize(name) {
  if (!name) return name;
  const lower = name.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Cache parsed schema in memory — same instance lives across warm invocations.
let cachedM2M = null;
let cachedUniPoint = null;

function getM2MSchema() {
  if (cachedM2M) return cachedM2M;
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', 'm2m-schema-slim.txt'), 'utf-8');
    cachedM2M = parseSchema(text);
  } catch (_e) {
    cachedM2M = [];
  }
  return cachedM2M;
}

function getUniPointSchema() {
  if (cachedUniPoint) return cachedUniPoint;
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', 'unipoint-schema-slim.txt'), 'utf-8');
    cachedUniPoint = parseSchema(text);
  } catch (_e) {
    cachedUniPoint = [];
  }
  return cachedUniPoint;
}

module.exports = async function (context, req) {
  if (req.method === 'OPTIONS') {
    context.res = {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    };
    return;
  }

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const database = (req.query.database || 'm2mdata99').toLowerCase();
  const tables = database === 'unipoint_live' ? getUniPointSchema() : getM2MSchema();

  context.res = {
    status: 200,
    headers: {
      ...CORS,
      'Cache-Control': 'public, max-age=3600',
    },
    body: JSON.stringify({ database, tables }),
  };
};
