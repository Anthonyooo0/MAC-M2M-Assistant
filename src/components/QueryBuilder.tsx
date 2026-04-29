import React, { useEffect, useMemo, useState } from 'react';

export interface SchemaColumn {
  name: string;
  description: string;
  type: string;
}

export interface SchemaTable {
  name: string;
  description: string;
  columns: SchemaColumn[];
}

export interface BuilderFilter {
  table: string;
  column: string;
  operator: string;
  value: string;
}

export interface BuilderPayload {
  tables: string[];
  columns: string[];
  filters: BuilderFilter[];
  clarifier: string;
}

interface QueryBuilderProps {
  schemaMetaUrl: string;
  database: string;
  isLoading: boolean;
  onSubmit: (payload: BuilderPayload) => void;
}

const OPERATORS = [
  { value: '=', label: 'equals' },
  { value: '<>', label: 'does not equal' },
  { value: 'LIKE', label: 'contains' },
  { value: 'NOT LIKE', label: 'does not contain' },
  { value: '>', label: 'greater than' },
  { value: '<', label: 'less than' },
  { value: '>=', label: 'greater than or equal' },
  { value: '<=', label: 'less than or equal' },
  { value: 'IS NULL', label: 'is empty' },
  { value: 'IS NOT NULL', label: 'is not empty' },
];

export const QueryBuilder: React.FC<QueryBuilderProps> = ({
  schemaMetaUrl,
  database,
  isLoading,
  onSubmit,
}) => {
  const [tables, setTables] = useState<SchemaTable[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tableSearch, setTableSearch] = useState('');
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [filters, setFilters] = useState<BuilderFilter[]>([]);
  const [clarifier, setClarifier] = useState('');
  const [activeTableForColumns, setActiveTableForColumns] = useState<string | null>(null);
  const [columnSearch, setColumnSearch] = useState('');

  useEffect(() => {
    if (!schemaMetaUrl) {
      setLoadError('Schema endpoint is not configured.');
      return;
    }
    const controller = new AbortController();
    const sep = schemaMetaUrl.includes('?') ? '&' : '?';
    const url = `${schemaMetaUrl}${sep}database=${encodeURIComponent(database)}`;
    fetch(url, { signal: controller.signal })
      .then(res => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json();
      })
      .then(data => {
        setTables(Array.isArray(data?.tables) ? data.tables : []);
        setLoadError(null);
      })
      .catch(err => {
        if (err.name !== 'AbortError') setLoadError(err.message || 'Failed to load schema.');
      });
    return () => controller.abort();
  }, [schemaMetaUrl, database]);

  // Reset selection if database changes
  useEffect(() => {
    setSelectedTables([]);
    setSelectedColumns([]);
    setFilters([]);
    setActiveTableForColumns(null);
  }, [database]);

  const filteredTables = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter(t =>
      t.description.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q)
    );
  }, [tables, tableSearch]);

  const tableByName = useMemo(() => {
    const map: Record<string, SchemaTable> = {};
    for (const t of tables) map[t.name] = t;
    return map;
  }, [tables]);

  const visibleColumnTable = activeTableForColumns ? tableByName[activeTableForColumns] : null;

  const filteredColumns = useMemo(() => {
    if (!visibleColumnTable) return [];
    const q = columnSearch.trim().toLowerCase();
    if (!q) return visibleColumnTable.columns;
    return visibleColumnTable.columns.filter(c =>
      c.description.toLowerCase().includes(q)
    );
  }, [visibleColumnTable, columnSearch]);

  const toggleTable = (tableName: string) => {
    setSelectedTables(prev => {
      if (prev.includes(tableName)) {
        // Removing the table — also strip its columns and filters
        setSelectedColumns(cols => cols.filter(c => !c.startsWith(`${tableName}.`)));
        setFilters(fs => fs.filter(f => f.table !== tableName));
        if (activeTableForColumns === tableName) setActiveTableForColumns(null);
        return prev.filter(t => t !== tableName);
      }
      if (!activeTableForColumns) setActiveTableForColumns(tableName);
      return [...prev, tableName];
    });
  };

  const toggleColumn = (tableName: string, columnName: string) => {
    const key = `${tableName}.${columnName}`;
    setSelectedColumns(prev =>
      prev.includes(key) ? prev.filter(c => c !== key) : [...prev, key]
    );
  };

  const addFilter = () => {
    if (selectedTables.length === 0) return;
    const firstTable = selectedTables[0];
    const firstColumn = tableByName[firstTable]?.columns[0]?.name || '';
    setFilters(prev => [
      ...prev,
      { table: firstTable, column: firstColumn, operator: '=', value: '' },
    ]);
  };

  const updateFilter = (idx: number, patch: Partial<BuilderFilter>) => {
    setFilters(prev => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  };

  const removeFilter = (idx: number) => {
    setFilters(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = () => {
    if (selectedTables.length === 0 || isLoading) return;
    onSubmit({
      tables: selectedTables,
      columns: selectedColumns,
      filters: filters.filter(f =>
        // IS NULL / IS NOT NULL don't need a value
        f.operator === 'IS NULL' || f.operator === 'IS NOT NULL' || f.value !== ''
      ),
      clarifier: clarifier.trim(),
    });
  };

  const labelForColumn = (key: string): string => {
    const [t, c] = key.split('.');
    const col = tableByName[t]?.columns.find(x => x.name === c);
    return col ? `${tableByName[t]?.description || t} → ${col.description}` : key;
  };

  return (
    <div className="bg-white rounded-lg border border-mauve-6 shadow-sm overflow-hidden view-transition">
      <div className="px-5 py-3 border-b bg-mauve-2 flex items-center justify-between">
        <div>
          <h3 className="font-bold text-mauve-12 text-sm">Query Builder</h3>
          <p className="text-[11px] text-mauve-11">
            Pick the data sources and conditions you want, then send. The assistant will write the query for you.
          </p>
        </div>
        <span className="text-[10px] font-mono text-mauve-9 uppercase">
          {selectedTables.length} sources · {selectedColumns.length} fields · {filters.length} filters
        </span>
      </div>

      {loadError && (
        <div className="px-5 py-3 bg-red-50 border-b border-red-200 text-red-700 text-xs">
          {loadError}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-mauve-6">
        {/* Tables panel */}
        <div className="p-4">
          <label className="block text-[10px] font-bold text-mauve-11 uppercase mb-2">
            1. Pick data sources
          </label>
          <input
            value={tableSearch}
            onChange={e => setTableSearch(e.target.value)}
            placeholder="Search data sources..."
            className="w-full mb-2 px-3 py-2 rounded-lg border border-mauve-7 focus:border-mauve-8 focus:ring-0 outline-none text-sm"
          />
          <div className="max-h-72 overflow-y-auto rounded-lg border border-mauve-6 divide-y divide-mauve-4">
            {filteredTables.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-mauve-9">
                No data sources match.
              </div>
            ) : (
              filteredTables.map(t => {
                const checked = selectedTables.includes(t.name);
                return (
                  <label
                    key={t.name}
                    className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${
                      checked ? 'bg-mac-navy/5' : 'hover:bg-mauve-2'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleTable(t.name)}
                      className="rounded border-mauve-7 text-mac-navy focus:ring-mac-accent"
                    />
                    <span className="flex-1 min-w-0 flex items-baseline gap-2">
                      <span className="text-sm text-mauve-12 truncate">{t.description}</span>
                      <span className="font-mono text-[10px] text-mauve-9 truncate">{t.name}</span>
                    </span>
                    {checked && (
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          setActiveTableForColumns(t.name);
                        }}
                        className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                          activeTableForColumns === t.name
                            ? 'bg-mac-navy text-white'
                            : 'text-mac-navy hover:bg-mac-navy/10'
                        }`}
                      >
                        Fields
                      </button>
                    )}
                  </label>
                );
              })
            )}
          </div>
        </div>

        {/* Columns panel */}
        <div className="p-4">
          <label className="block text-[10px] font-bold text-mauve-11 uppercase mb-2">
            2. Pick fields to return (optional)
          </label>
          {!visibleColumnTable ? (
            <div className="rounded-lg border border-dashed border-mauve-7 px-3 py-8 text-center text-xs text-mauve-9">
              {selectedTables.length === 0
                ? 'Pick a data source first.'
                : 'Click "Fields" on a selected source to view its fields.'}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-mauve-12 truncate flex items-baseline gap-2">
                  <span>{visibleColumnTable.description}</span>
                  <span className="font-mono text-[10px] font-normal text-mauve-9">
                    {visibleColumnTable.name}
                  </span>
                </span>
                <span className="text-[10px] text-mauve-9">
                  {visibleColumnTable.columns.length} fields
                </span>
              </div>
              <input
                value={columnSearch}
                onChange={e => setColumnSearch(e.target.value)}
                placeholder="Search fields..."
                className="w-full mb-2 px-3 py-2 rounded-lg border border-mauve-7 focus:border-mauve-8 focus:ring-0 outline-none text-sm"
              />
              <div className="max-h-72 overflow-y-auto rounded-lg border border-mauve-6 divide-y divide-mauve-4">
                {filteredColumns.map(c => {
                  const key = `${visibleColumnTable.name}.${c.name}`;
                  const checked = selectedColumns.includes(key);
                  return (
                    <label
                      key={key}
                      className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${
                        checked ? 'bg-mac-navy/5' : 'hover:bg-mauve-2'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleColumn(visibleColumnTable.name, c.name)}
                        className="rounded border-mauve-7 text-mac-navy focus:ring-mac-accent"
                      />
                      <span className="text-sm text-mauve-12 flex-1">{c.description}</span>
                    </label>
                  );
                })}
                {filteredColumns.length === 0 && (
                  <div className="px-3 py-6 text-center text-xs text-mauve-9">
                    No fields match.
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="px-4 py-4 border-t border-mauve-6">
        <div className="flex items-center justify-between mb-2">
          <label className="block text-[10px] font-bold text-mauve-11 uppercase">
            3. Conditions (optional)
          </label>
          <button
            onClick={addFilter}
            disabled={selectedTables.length === 0}
            className="text-xs font-bold text-mac-navy hover:text-mac-blue disabled:text-mauve-7 disabled:cursor-not-allowed"
          >
            + Add condition
          </button>
        </div>
        {filters.length === 0 ? (
          <p className="text-xs text-mauve-9 italic">
            No conditions. The query will return everything in the chosen sources.
          </p>
        ) : (
          <div className="space-y-2">
            {filters.map((f, idx) => {
              const tableMeta = tableByName[f.table];
              const needsValue = f.operator !== 'IS NULL' && f.operator !== 'IS NOT NULL';
              return (
                <div key={idx} className="flex items-center gap-2 flex-wrap">
                  <select
                    value={f.table}
                    onChange={e => {
                      const newTable = e.target.value;
                      const firstCol = tableByName[newTable]?.columns[0]?.name || '';
                      updateFilter(idx, { table: newTable, column: firstCol });
                    }}
                    className="px-2 py-1.5 rounded-lg border border-mauve-7 text-sm bg-white"
                  >
                    {selectedTables.map(t => (
                      <option key={t} value={t}>
                        {tableByName[t]?.description ? `${tableByName[t]?.description} (${t})` : t}
                      </option>
                    ))}
                  </select>
                  <select
                    value={f.column}
                    onChange={e => updateFilter(idx, { column: e.target.value })}
                    className="px-2 py-1.5 rounded-lg border border-mauve-7 text-sm bg-white"
                  >
                    {tableMeta?.columns.map(c => (
                      <option key={c.name} value={c.name}>{c.description}</option>
                    ))}
                  </select>
                  <select
                    value={f.operator}
                    onChange={e => updateFilter(idx, { operator: e.target.value })}
                    className="px-2 py-1.5 rounded-lg border border-mauve-7 text-sm bg-white"
                  >
                    {OPERATORS.map(op => (
                      <option key={op.value} value={op.value}>{op.label}</option>
                    ))}
                  </select>
                  {needsValue && (
                    <input
                      value={f.value}
                      onChange={e => updateFilter(idx, { value: e.target.value })}
                      placeholder="value"
                      className="px-2 py-1.5 rounded-lg border border-mauve-7 text-sm flex-1 min-w-[100px]"
                    />
                  )}
                  <button
                    onClick={() => removeFilter(idx)}
                    className="text-mauve-9 hover:text-red-500 px-2"
                    title="Remove"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Clarifier + submit */}
      <div className="px-4 py-4 border-t border-mauve-6 bg-mauve-2">
        <label className="block text-[10px] font-bold text-mauve-11 uppercase mb-2">
          4. Anything else? (optional)
        </label>
        <textarea
          value={clarifier}
          onChange={e => setClarifier(e.target.value)}
          placeholder='e.g., "only orders from this year, sorted newest first"'
          rows={2}
          className="w-full px-3 py-2 rounded-lg border border-mauve-7 focus:border-mauve-8 focus:ring-0 outline-none text-sm resize-none"
        />

        {selectedColumns.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {selectedColumns.slice(0, 8).map(key => (
              <span
                key={key}
                className="px-2 py-0.5 bg-mac-navy/10 text-mac-navy rounded text-[10px] font-medium"
              >
                {labelForColumn(key)}
              </span>
            ))}
            {selectedColumns.length > 8 && (
              <span className="px-2 py-0.5 text-mauve-11 text-[10px]">
                +{selectedColumns.length - 8} more
              </span>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button
            onClick={handleSubmit}
            disabled={selectedTables.length === 0 || isLoading}
            className="px-5 py-2.5 bg-mac-navy hover:bg-mac-blue text-white font-bold rounded-lg text-sm transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Build & Run Query
          </button>
        </div>
      </div>
    </div>
  );
};
