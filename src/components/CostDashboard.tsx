import React, { useState, useEffect, useCallback } from 'react';

interface CostSummary {
  today_cost: number;
  today_calls: number;
  today_queries: number;
  week_cost: number;
  week_calls: number;
  week_queries: number;
  month_cost: number;
  month_calls: number;
  month_queries: number;
  total_cost: number;
  total_calls: number;
  total_queries: number;
}

interface UserCost {
  user: string;
  queries: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
}

interface SessionCost {
  session_id: string;
  session_title: string;
  user_email: string;
  queries: number;
  calls: number;
  cost: number;
  first_query: string;
  last_query: string;
}

interface CostDashboardProps {
  costsUrl: string;
}

export const CostDashboard: React.FC<CostDashboardProps> = ({ costsUrl }) => {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [byUser, setByUser] = useState<UserCost[]>([]);
  const [bySessions, setBySessions] = useState<SessionCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'users' | 'sessions'>('overview');

  const loadData = useCallback(async () => {
    if (!costsUrl) return;
    setLoading(true);
    try {
      const [summaryRes, userRes, sessionRes] = await Promise.all([
        fetch(`${costsUrl}&type=summary`),
        fetch(`${costsUrl}&type=by-user`),
        fetch(`${costsUrl}&type=by-session`),
      ]);
      if (summaryRes.ok) setSummary(await summaryRes.json());
      if (userRes.ok) setByUser(await userRes.json());
      if (sessionRes.ok) setBySessions(await sessionRes.json());
    } catch (err) {
      console.error('Failed to load cost data:', err);
    } finally {
      setLoading(false);
    }
  }, [costsUrl]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [loadData]);

  if (loading && !summary) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-mac-navy rounded-full animate-spin"></div>
      </div>
    );
  }

  const formatCost = (cost: number) => `$${(cost || 0).toFixed(4)}`;
  const formatTokens = (tokens: number) => (tokens || 0).toLocaleString();

  return (
    <div className="flex-1 overflow-y-auto p-6 view-transition">
      <div className="max-w-6xl mx-auto space-y-6">

        {/* Summary Cards */}
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-white p-5 rounded-xl border-l-4 border-l-mac-accent shadow-sm">
            <div className="text-[10px] font-bold text-slate-400 uppercase">Today</div>
            <div className="text-2xl font-bold text-slate-800">{formatCost(summary?.today_cost || 0)}</div>
            <div className="text-xs text-slate-400 mt-1">{summary?.today_queries || 0} queries / {summary?.today_calls || 0} API calls</div>
          </div>
          <div className="bg-white p-5 rounded-xl border-l-4 border-l-blue-500 shadow-sm">
            <div className="text-[10px] font-bold text-slate-400 uppercase">This Week</div>
            <div className="text-2xl font-bold text-slate-800">{formatCost(summary?.week_cost || 0)}</div>
            <div className="text-xs text-slate-400 mt-1">{summary?.week_queries || 0} queries / {summary?.week_calls || 0} API calls</div>
          </div>
          <div className="bg-white p-5 rounded-xl border-l-4 border-l-green-500 shadow-sm">
            <div className="text-[10px] font-bold text-slate-400 uppercase">This Month</div>
            <div className="text-2xl font-bold text-slate-800">{formatCost(summary?.month_cost || 0)}</div>
            <div className="text-xs text-slate-400 mt-1">{summary?.month_queries || 0} queries / {summary?.month_calls || 0} API calls</div>
          </div>
          <div className="bg-white p-5 rounded-xl border-l-4 border-l-slate-300 shadow-sm">
            <div className="text-[10px] font-bold text-slate-400 uppercase">All Time</div>
            <div className="text-2xl font-bold text-slate-800">{formatCost(summary?.total_cost || 0)}</div>
            <div className="text-xs text-slate-400 mt-1">{summary?.total_queries || 0} queries / {summary?.total_calls || 0} API calls</div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1 w-fit">
          {(['overview', 'users', 'sessions'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 rounded-md text-sm font-bold transition-all ${
                activeTab === tab ? 'bg-white text-mac-navy shadow-sm' : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              {tab === 'overview' ? 'Overview' : tab === 'users' ? 'By User' : 'By Session'}
            </button>
          ))}
          <button
            onClick={loadData}
            className="px-3 py-2 rounded-md text-sm text-slate-400 hover:text-mac-accent transition-all"
            title="Refresh"
          >
            ↻
          </button>
        </div>

        {/* By User Table */}
        {activeTab === 'users' && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b bg-slate-50">
              <h3 className="font-bold text-slate-700 text-sm">Cost by User (This Month)</h3>
            </div>
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-5 py-3 font-bold text-slate-600 text-xs uppercase">User</th>
                  <th className="px-5 py-3 font-bold text-slate-600 text-xs uppercase">Queries</th>
                  <th className="px-5 py-3 font-bold text-slate-600 text-xs uppercase">API Calls</th>
                  <th className="px-5 py-3 font-bold text-slate-600 text-xs uppercase">Input Tokens</th>
                  <th className="px-5 py-3 font-bold text-slate-600 text-xs uppercase">Output Tokens</th>
                  <th className="px-5 py-3 font-bold text-slate-600 text-xs uppercase">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {byUser.map((u, i) => (
                  <tr key={i} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3 font-medium text-slate-800">{u.user}</td>
                    <td className="px-5 py-3 text-slate-600 font-mono text-xs">{u.queries}</td>
                    <td className="px-5 py-3 text-slate-600 font-mono text-xs">{u.calls}</td>
                    <td className="px-5 py-3 text-slate-600 font-mono text-xs">{formatTokens(u.input_tokens)}</td>
                    <td className="px-5 py-3 text-slate-600 font-mono text-xs">{formatTokens(u.output_tokens)}</td>
                    <td className="px-5 py-3 font-bold text-emerald-600 font-mono text-xs">{formatCost(u.cost)}</td>
                  </tr>
                ))}
                {byUser.length === 0 && (
                  <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400">No data yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* By Session Table */}
        {activeTab === 'sessions' && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b bg-slate-50">
              <h3 className="font-bold text-slate-700 text-sm">Cost by Session (This Month)</h3>
            </div>
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-5 py-3 font-bold text-slate-600 text-xs uppercase">Session</th>
                  <th className="px-5 py-3 font-bold text-slate-600 text-xs uppercase">User</th>
                  <th className="px-5 py-3 font-bold text-slate-600 text-xs uppercase">Queries</th>
                  <th className="px-5 py-3 font-bold text-slate-600 text-xs uppercase">API Calls</th>
                  <th className="px-5 py-3 font-bold text-slate-600 text-xs uppercase">Cost</th>
                  <th className="px-5 py-3 font-bold text-slate-600 text-xs uppercase">Last Query</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {bySessions.map((s, i) => (
                  <tr key={i} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3 text-slate-800 max-w-xs truncate" title={s.session_title}>{s.session_title || 'Untitled'}</td>
                    <td className="px-5 py-3 text-slate-600 text-xs">{s.user_email?.split('@')[0] || '?'}</td>
                    <td className="px-5 py-3 text-slate-600 font-mono text-xs">{s.queries}</td>
                    <td className="px-5 py-3 text-slate-600 font-mono text-xs">{s.calls}</td>
                    <td className="px-5 py-3 font-bold text-emerald-600 font-mono text-xs">{formatCost(s.cost)}</td>
                    <td className="px-5 py-3 text-slate-400 text-xs font-mono">{s.last_query ? new Date(s.last_query).toLocaleDateString() : '—'}</td>
                  </tr>
                ))}
                {bySessions.length === 0 && (
                  <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400">No data yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Overview — summary stats with some context */}
        {activeTab === 'overview' && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <h3 className="font-bold text-slate-700 text-sm mb-4">Gemini API Usage Overview</h3>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase mb-3">Cost Breakdown (This Month)</h4>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Total Queries</span>
                    <span className="font-mono font-bold text-slate-800">{summary?.month_queries || 0}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Total API Calls (incl. retries)</span>
                    <span className="font-mono font-bold text-slate-800">{summary?.month_calls || 0}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Avg Cost per Query</span>
                    <span className="font-mono font-bold text-emerald-600">
                      {summary?.month_queries ? formatCost((summary.month_cost || 0) / summary.month_queries) : '$0.0000'}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Retry Rate</span>
                    <span className="font-mono font-bold text-slate-800">
                      {summary?.month_queries && summary?.month_calls
                        ? `${(((summary.month_calls - summary.month_queries) / summary.month_queries) * 100).toFixed(1)}%`
                        : '0%'}
                    </span>
                  </div>
                </div>
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase mb-3">Pricing (Gemini 3.1 Pro Preview)</h4>
                <div className="space-y-2 text-sm text-slate-600">
                  <div className="flex justify-between">
                    <span>Input tokens</span>
                    <span className="font-mono">$1.25 / 1M tokens</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Output tokens</span>
                    <span className="font-mono">$10.00 / 1M tokens</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Schema size (per request)</span>
                    <span className="font-mono">~50K tokens</span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-slate-100">
                    <span className="font-bold text-slate-700">Est. cost per query</span>
                    <span className="font-mono font-bold text-emerald-600">~$0.07 - $0.10</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
