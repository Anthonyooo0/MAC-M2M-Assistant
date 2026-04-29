import React, { useState, useEffect, useCallback } from 'react';

interface AdminSession {
  id: string;
  title: string;
  user_email: string;
  created_at: string;
  updated_at: string;
}

interface AdminMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sql?: string;
  columns?: string[];
  rows?: Record<string, any>[];
  rowCount?: number;
  error?: string;
}

interface AdminViewProps {
  chatSessionsUrl: string;
  chatMessagesUrl: string;
  currentUser: string;
}

export const AdminView: React.FC<AdminViewProps> = ({ chatSessionsUrl, chatMessagesUrl, currentUser }) => {
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<AdminSession | null>(null);
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [filterUser, setFilterUser] = useState('');

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${chatSessionsUrl}&userEmail=${encodeURIComponent(currentUser)}&admin=true`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
    } catch (err) {
      console.error('Failed to load admin sessions:', err);
    } finally {
      setLoading(false);
    }
  }, [chatSessionsUrl, currentUser]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const loadMessages = async (session: AdminSession) => {
    setSelectedSession(session);
    setLoadingMessages(true);
    try {
      const res = await fetch(`${chatMessagesUrl}&sessionId=${session.id}`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data);
      }
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      setLoadingMessages(false);
    }
  };

  // Get unique users for filter
  const uniqueUsers = [...new Set(sessions.map(s => s.user_email))].sort();

  // Filter sessions
  const filteredSessions = filterUser
    ? sessions.filter(s => s.user_email === filterUser)
    : sessions;

  return (
    <div className="flex-1 overflow-hidden flex view-transition">
      {/* Sessions List */}
      <div className="w-80 border-r border-mauve-6 bg-white flex flex-col overflow-hidden">
        <div className="p-4 border-b border-mauve-6 space-y-3">
          <h3 className="font-bold text-mauve-12 text-sm">All Chat Sessions</h3>
          <select
            value={filterUser}
            onChange={(e) => setFilterUser(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-mauve-7 text-xs focus:border-mauve-8 focus:ring-0 outline-none bg-white"
          >
            <option value="">All Users ({sessions.length})</option>
            {uniqueUsers.map(email => (
              <option key={email} value={email}>
                {email.split('@')[0]} ({sessions.filter(s => s.user_email === email).length})
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-xs text-mauve-9">Loading sessions...</div>
          ) : filteredSessions.length === 0 ? (
            <div className="p-4 text-xs text-mauve-9">No sessions found</div>
          ) : (
            filteredSessions.map(session => (
              <button
                key={session.id}
                onClick={() => loadMessages(session)}
                className={`w-full text-left px-4 py-3 border-b border-mauve-4 hover:bg-mauve-2 transition-colors ${
                  selectedSession?.id === session.id ? 'bg-blue-50 border-l-2 border-l-mac-accent' : ''
                }`}
              >
                <div className="text-sm font-medium text-mauve-12 truncate">{session.title}</div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] font-bold text-mac-navy uppercase">
                    {session.user_email.split('@')[0]}
                  </span>
                  <span className="text-[10px] text-mauve-9 font-mono">
                    {new Date(session.updated_at).toLocaleDateString()}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Message Detail */}
      <div className="flex-1 overflow-y-auto bg-mauve-2">
        {!selectedSession ? (
          <div className="flex items-center justify-center h-full text-mauve-9 text-sm">
            Select a session to view its messages and SQL queries
          </div>
        ) : loadingMessages ? (
          <div className="flex items-center justify-center h-full text-mauve-9 text-sm">
            Loading messages...
          </div>
        ) : (
          <div className="max-w-4xl mx-auto p-6 space-y-4">
            {/* Session header */}
            <div className="bg-white rounded-lg border border-mauve-6 shadow-sm p-4">
              <h3 className="font-bold text-mauve-12">{selectedSession.title}</h3>
              <div className="flex items-center gap-4 mt-1">
                <span className="text-xs text-mac-navy font-bold">{selectedSession.user_email}</span>
                <span className="text-[10px] text-mauve-9 font-mono">
                  Created: {new Date(selectedSession.created_at).toLocaleString()}
                </span>
                <span className="text-[10px] text-mauve-9 font-mono">
                  Updated: {new Date(selectedSession.updated_at).toLocaleString()}
                </span>
              </div>
            </div>

            {/* Messages */}
            {messages.length === 0 ? (
              <div className="text-center text-mauve-9 text-sm py-8">No messages in this session</div>
            ) : (
              messages.map((msg, idx) => (
                <div key={msg.id || idx} className={`rounded-lg border shadow-sm overflow-hidden ${
                  msg.role === 'user'
                    ? 'bg-mac-navy text-white border-mac-navy'
                    : msg.error
                      ? 'bg-red-50 border-red-200'
                      : 'bg-white border-mauve-6'
                }`}>
                  {/* Message header */}
                  <div className={`px-4 py-2 text-[10px] font-bold uppercase tracking-wider flex items-center justify-between ${
                    msg.role === 'user'
                      ? 'bg-mauve-11/40 text-mauve-7'
                      : msg.error
                        ? 'bg-red-100 text-red-500'
                        : 'bg-mauve-2 text-mauve-9'
                  }`}>
                    <span>{msg.role === 'user' ? 'User' : 'Assistant'}</span>
                    {msg.rowCount != null && (
                      <span className="text-[10px] font-mono">{msg.rowCount} rows</span>
                    )}
                  </div>

                  {/* Content */}
                  <div className="px-4 py-3">
                    <p className={`text-sm ${msg.role === 'user' ? 'text-white' : msg.error ? 'text-red-700' : 'text-mauve-12'}`}>
                      {msg.content}
                    </p>
                  </div>

                  {/* SQL Query - the key feature for admin */}
                  {msg.sql && (
                    <div className="border-t border-mauve-6">
                      <div className="px-4 py-2 bg-mauve-12">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] font-bold text-green-400 uppercase tracking-wider">SQL Query</span>
                          <button
                            onClick={() => navigator.clipboard.writeText(msg.sql || '')}
                            className="text-[10px] text-mauve-9 hover:text-white transition-colors"
                          >
                            Copy
                          </button>
                        </div>
                        <pre className="text-green-400 text-xs overflow-x-auto font-mono whitespace-pre-wrap">{msg.sql}</pre>
                      </div>
                    </div>
                  )}

                  {/* Error detail */}
                  {msg.error && (
                    <div className="px-4 py-2 bg-red-100 border-t border-red-200">
                      <span className="text-[10px] font-bold text-red-500 uppercase">Error: </span>
                      <span className="text-xs text-red-600">{msg.error}</span>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};
