import React, { useState } from 'react';

interface ResultsTableProps {
  columns: string[];
  rows: Record<string, any>[];
  sql: string;
}

export const ResultsTable: React.FC<ResultsTableProps> = ({ columns, rows }) => {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [search, setSearch] = useState('');

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
          return String(val).toLowerCase().includes(search.toLowerCase());
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
    <div className="mt-3 ml-11 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden view-transition">
      {/* Toolbar */}
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
            {sortedRows.length} of {rows.length} row{rows.length !== 1 ? 's' : ''}
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter results..."
            className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:border-mac-accent outline-none w-48"
          />
        </div>
        <button
          onClick={handleExportCSV}
          className="px-3 py-1.5 text-[10px] font-bold text-mac-accent hover:bg-blue-50 border border-slate-200 rounded-lg uppercase tracking-wider transition-colors"
        >
          Export CSV
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 z-10">
            <tr className="border-b border-slate-200">
              {columns.map((col) => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                  className="text-left px-4 py-2.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-mac-accent whitespace-nowrap select-none"
                >
                  {col}
                  {sortCol === col && (
                    <span className="ml-1">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sortedRows.map((row, i) => (
              <tr key={i} className="hover:bg-slate-50 transition-colors">
                {columns.map((col) => {
                  const val = row[col];
                  const display = val == null ? '' : typeof val === 'string' ? val.trimEnd() : String(val);
                  return (
                    <td key={col} className="px-4 py-2 text-slate-700 whitespace-nowrap max-w-[300px] truncate" title={display}>
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
