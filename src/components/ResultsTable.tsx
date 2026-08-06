import React, { useState } from 'react';

export interface ColumnSource {
  expression: string;
  tables: string[];
}

interface ResultsTableProps {
  columns: string[];
  rows: Record<string, any>[];
  sql: string;
  columnSources?: Record<string, ColumnSource>;
}

// M2M returns pure dates as midnight-UTC ISO timestamps (e.g. 2024-11-22T00:00:00.000Z).
// Show those as M/D/YYYY. The date parts are read straight from the string (no Date
// parsing) so there is no timezone shift, and only midnight-UTC values match, so real
// timestamps with a time-of-day keep their full value.
const MIDNIGHT_ISO = /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.000)?Z$/;

function formatCell(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string') {
    const m = val.match(MIDNIGHT_ISO);
    if (m) return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
    return val.trimEnd();
  }
  return String(val);
}

export const ResultsTable: React.FC<ResultsTableProps> = ({ columns, rows, columnSources }) => {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [search, setSearch] = useState('');
  const [hoverCol, setHoverCol] = useState<string | null>(null);

  if (!columns.length || !rows.length) return null;

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  // Filter rows
  const filteredRows = search
    ? rows.filter(row =>
        columns.some(col => {
          const val = row[col];
          if (val == null) return false;
          return formatCell(val).toLowerCase().includes(search.toLowerCase());
        })
      )
    : rows;

  // Sort rows
  const sortedRows = sortCol
    ? [...filteredRows].sort((a, b) => {
        const aVal = a[sortCol] ?? '';
        const bVal = b[sortCol] ?? '';
        const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : filteredRows;

  const handleExportCSV = () => {
    const header = columns.join(',');
    const csvRows = sortedRows.map(row =>
      columns.map(col => {
        const val = row[col];
        if (val == null) return '';
        const str = String(val);
        return str.includes(',') || str.includes('"') || str.includes('\n')
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      }).join(',')
    );
    const csv = [header, ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `m2m-export-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mt-3 ml-0 sm:ml-11 bg-white rounded-lg border border-mauve-6 shadow-sm overflow-hidden view-transition">
      {/* Toolbar */}
      <div className="px-3 sm:px-4 py-3 bg-mauve-2 border-b border-mauve-6 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
          <span className="text-[10px] font-bold text-mauve-9 uppercase tracking-wider flex-shrink-0">
            {sortedRows.length} of {rows.length} row{rows.length !== 1 ? 's' : ''}
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter results..."
            className="px-3 py-1.5 text-xs border border-mauve-6 rounded-lg focus:border-mauve-8 outline-none flex-1 min-w-0 sm:flex-none sm:w-48"
          />
        </div>
        <button
          onClick={handleExportCSV}
          className="px-3 py-1.5 text-[10px] font-bold text-mac-navy hover:bg-mauve-3 border border-mauve-6 rounded-lg uppercase tracking-wider transition-colors"
        >
          Export CSV
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-mauve-2 z-10">
            <tr className="border-b border-mauve-6">
              {columns.map((col) => {
                const src = columnSources?.[col];
                return (
                  <th
                    key={col}
                    onClick={() => handleSort(col)}
                    onMouseEnter={() => setHoverCol(col)}
                    onMouseLeave={() => setHoverCol(c => c === col ? null : c)}
                    className="relative text-left px-4 py-2.5 text-[10px] font-bold text-mauve-9 uppercase tracking-wider cursor-pointer hover:text-mac-navy whitespace-nowrap select-none"
                  >
                    <span className="inline-flex items-center gap-1">
                      {col}
                      {src && (
                        <svg className="w-3 h-3 text-mauve-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      )}
                    </span>
                    {sortCol === col && (
                      <span className="ml-1">{sortDir === 'asc' ? '▲' : '▼'}</span>
                    )}
                    {hoverCol === col && src && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="absolute left-2 top-full mt-1 z-20 w-72 px-3 py-2 bg-mac-navy text-white rounded-lg shadow-sm normal-case tracking-normal"
                      >
                        <div className="text-[9px] font-bold text-mauve-7 uppercase tracking-wider mb-0.5">Source field</div>
                        <div className="text-xs font-mono break-all mb-2">{src.expression}</div>
                        <div className="text-[9px] font-bold text-mauve-7 uppercase tracking-wider mb-0.5">From table{src.tables.length > 1 ? 's' : ''}</div>
                        <div className="text-xs font-mono break-all">{src.tables.join(', ')}</div>
                      </div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-mauve-4">
            {sortedRows.map((row, i) => (
              <tr key={i} className="hover:bg-mauve-2 transition-colors">
                {columns.map((col) => {
                  const val = row[col];
                  const display = formatCell(val);
                  return (
                    <td key={col} className="px-4 py-2 text-mauve-12 whitespace-nowrap max-w-[300px] truncate" title={display}>
                      {display}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
