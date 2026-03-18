import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { ALLOWED_DOMAIN } from './authConfig';
import { Login } from './components/Login';
import { ChatMessage } from './components/ChatMessage';
import { ResultsTable } from './components/ResultsTable';
import { AdminView } from './components/AdminView';

const M2M_QUERY_URL = import.meta.env.VITE_M2M_QUERY_URL || '';
const CHAT_SESSIONS_URL = import.meta.env.VITE_CHAT_SESSIONS_URL || '';
const CHAT_MESSAGES_URL = import.meta.env.VITE_CHAT_MESSAGES_URL || '';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sql?: string;
  columns?: string[];
  rows?: Record<string, any>[];
  rowCount?: number;
  error?: string;
  loading?: boolean;
}

interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  user_email?: string;  // populated in admin mode
}

const ADMIN_EMAILS = ['anthony.jimenez@macproducts.net'];

// Company/tenant configuration
interface Company {
  id: string;
  name: string;
  shortName: string;
  logo: string;
  database: string; // sent to backend to pick connection string
}

const COMPANIES: Company[] = [
  { id: 'mac-products', name: 'MAC Products', shortName: 'MAC PRODUCTS', logo: '/mac_logo.png', database: 'm2mdata99' },
  { id: 'mac-impulse', name: 'MAC Impulse', shortName: 'MAC IMPULSE', logo: '/mac_impulse_logo.png', database: 'm2mdata66' },
];

// Map of users who have access to specific companies (by email → company IDs)
// Users not in this map get MAC Products only by default
const MULTI_COMPANY_USERS: Record<string, string[]> = {
  'henry.russnow@macproducts.net': ['mac-products', 'mac-impulse'],
  'anthony.jimenez@macproducts.net': ['mac-products', 'mac-impulse'],
  'juan.ortiz@macproducts.net': ['mac-products', 'mac-impulse'],
  'edward.russnow@macproducts.net': ['mac-products', 'mac-impulse'],
};

function App() {
  const { instance, accounts } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Chat history state
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const [adminMode, setAdminMode] = useState(false);
  const [viewMode, setViewMode] = useState<'chat' | 'admin'>('chat');

  // Company/tenant state
  const userCompanyIds = MULTI_COMPANY_USERS[currentUser || ''] || ['mac-products'];
  const userCompanies = COMPANIES.filter(c => userCompanyIds.includes(c.id));
  const [activeCompanyId, setActiveCompanyId] = useState('mac-products');
  const activeCompany = COMPANIES.find(c => c.id === activeCompanyId) || COMPANIES[0];

  const chatHistoryEnabled = !!CHAT_SESSIONS_URL && !!CHAT_MESSAGES_URL;
  const isAdmin = ADMIN_EMAILS.includes(currentUser || '');

  useEffect(() => {
    if (isAuthenticated && accounts.length > 0) {
      const email = accounts[0].username?.toLowerCase() || '';
      if (email.endsWith(`@${ALLOWED_DOMAIN}`)) {
        setCurrentUser(email);
      }
    }
  }, [isAuthenticated, accounts]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Load sessions when user logs in
  useEffect(() => {
    if (currentUser && chatHistoryEnabled) {
      loadSessions();
    }
  }, [currentUser]);

  // Focus rename input
  useEffect(() => {
    if (editingSessionId) editInputRef.current?.focus();
  }, [editingSessionId]);

  const loadSessions = useCallback(async (forceAdmin?: boolean) => {
    if (!currentUser || !chatHistoryEnabled) return;
    const useAdmin = forceAdmin !== undefined ? forceAdmin : adminMode;
    setLoadingSessions(true);
    try {
      let url = `${CHAT_SESSIONS_URL}&userEmail=${encodeURIComponent(currentUser)}`;
      if (useAdmin && isAdmin) url += '&admin=true';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
    } catch (err) {
      console.error('Failed to load sessions:', err);
    } finally {
      setLoadingSessions(false);
    }
  }, [currentUser, adminMode, isAdmin]);

  const createSession = useCallback(async (): Promise<string | null> => {
    if (!currentUser || !chatHistoryEnabled) return null;
    try {
      const res = await fetch(CHAT_SESSIONS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userEmail: currentUser }),
      });
      if (res.ok) {
        const session = await res.json();
        setSessions(prev => [session, ...prev]);
        return session.id;
      }
    } catch (err) {
      console.error('Failed to create session:', err);
    }
    return null;
  }, [currentUser]);

  const saveMessages = useCallback(async (sessionId: string, msgs: Message[]) => {
    if (!chatHistoryEnabled) return;
    try {
      await fetch(CHAT_MESSAGES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          messages: msgs.map(m => ({
            role: m.role,
            content: m.content,
            sql: m.sql,
            columns: m.columns,
            rows: m.rows,
            rowCount: m.rowCount,
            error: m.error,
          })),
        }),
      });
      // Refresh sessions to get updated title
      loadSessions();
    } catch (err) {
      console.error('Failed to save messages:', err);
    }
  }, [loadSessions]);

  const loadSessionMessages = useCallback(async (sessionId: string) => {
    if (!chatHistoryEnabled) return;
    try {
      const res = await fetch(`${CHAT_MESSAGES_URL}&sessionId=${encodeURIComponent(sessionId)}`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data);
        setActiveSessionId(sessionId);
      }
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  }, []);

  const renameSession = useCallback(async (sessionId: string, title: string) => {
    if (!chatHistoryEnabled) return;
    try {
      await fetch(CHAT_SESSIONS_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, title }),
      });
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title } : s));
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
    setEditingSessionId(null);
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    if (!chatHistoryEnabled) return;
    try {
      await fetch(`${CHAT_SESSIONS_URL}&sessionId=${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setMessages([]);
      }
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  }, [activeSessionId]);

  const handleLogout = async () => {
    await instance.logoutPopup();
    setCurrentUser(null);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    // Auto-create session if none active
    let sessionId = activeSessionId;
    if (!sessionId && chatHistoryEnabled) {
      sessionId = await createSession();
      if (sessionId) setActiveSessionId(sessionId);
    }

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
    };

    const loadingMsg: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '',
      loading: true,
    };

    setMessages(prev => [...prev, userMsg, loadingMsg]);
    setInput('');
    setIsLoading(true);

    try {
      // Build history for context
      const history = messages
        .filter(m => !m.loading)
        .map(m => ({
          role: m.role === 'user' ? 'user' : 'model',
          content: m.role === 'user' ? m.content : (m.sql || m.content),
        }));

      const res = await fetch(M2M_QUERY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history, database: activeCompany.database }),
      });

      const data = await res.json();

      const explanation = data.explanation || '';
      let content = '';
      if (data.error) {
        content = `Error: ${data.error}`;
      } else if (explanation) {
        content = explanation;
      } else if (data.rowCount != null) {
        content = `Found ${data.rowCount} result${data.rowCount !== 1 ? 's' : ''}.`;
      } else {
        content = 'Done.';
      }

      const assistantMsg: Message = {
        id: loadingMsg.id,
        role: 'assistant',
        content,
        sql: data.sql,
        columns: data.columns,
        rows: data.rows,
        rowCount: data.rowCount,
        error: data.error,
      };

      setMessages(prev => prev.map(m => m.id === loadingMsg.id ? assistantMsg : m));

      // Save to Azure SQL
      if (sessionId && chatHistoryEnabled) {
        saveMessages(sessionId, [userMsg, assistantMsg]);
      }
    } catch (err: any) {
      const errorMsg: Message = {
        id: loadingMsg.id,
        role: 'assistant',
        content: `Error: ${err.message}`,
        error: err.message,
      };
      setMessages(prev => prev.map(m => m.id === loadingMsg.id ? errorMsg : m));

      if (sessionId && chatHistoryEnabled) {
        saveMessages(sessionId, [userMsg, errorMsg]);
      }
    } finally {
      setIsLoading(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewChat = () => {
    setMessages([]);
    setActiveSessionId(null);
    setInput('');
    inputRef.current?.focus();
  };

  const handleSelectSession = (session: ChatSession) => {
    if (session.id === activeSessionId) return;
    loadSessionMessages(session.id);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent, sessionId: string) => {
    if (e.key === 'Enter') {
      renameSession(sessionId, editTitle);
    } else if (e.key === 'Escape') {
      setEditingSessionId(null);
    }
  };

  // Auth gate
  if (!isAuthenticated || !currentUser) {
    if (isAuthenticated && accounts.length > 0) {
      const email = accounts[0].username?.toLowerCase() || '';
      if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
        return (
          <div className="flex h-screen items-center justify-center bg-mac-light">
            <div className="text-center">
              <p className="text-red-600 font-bold">Access denied. Only @macproducts.net accounts allowed.</p>
              <button onClick={handleLogout} className="mt-4 px-4 py-2 bg-mac-navy text-white rounded-lg">Sign Out</button>
            </div>
          </div>
        );
      }
    }
    return <Login />;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-mac-light font-sans">
      {/* Sidebar */}
      <aside className={`sidebar flex flex-col ${sidebarCollapsed ? 'w-16' : 'w-64'} transition-all duration-300 flex-shrink-0 text-white`}>
        {/* Logo */}
        <div className="p-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 flex items-center justify-center flex-shrink-0 bg-white rounded-lg p-1">
              <img src={activeCompany.logo} alt={activeCompany.name} className="w-full h-full object-contain" />
            </div>
            {!sidebarCollapsed && (
              <div className="overflow-hidden">
                <h1 className="font-bold text-sm truncate uppercase">M2M Assistant</h1>
                <p className="text-blue-200 text-[10px] truncate uppercase font-bold tracking-tighter">
                  {currentUser}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* New Chat Button */}
        <div className="p-3">
          <button
            onClick={handleNewChat}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm text-blue-200 hover:text-white hover:bg-white/10 rounded-lg transition-all border border-white/10"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {!sidebarCollapsed && <span className="font-medium">New Chat</span>}
          </button>
        </div>

        {/* Chat History */}
        {!sidebarCollapsed && chatHistoryEnabled && (
          <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
            <div className="px-3 py-2 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-blue-300/50">
                {adminMode ? 'All Users\' Chats' : 'Recent Chats'}
              </span>
              {isAdmin && (
                <button
                  onClick={() => {
                    const next = !adminMode;
                    setAdminMode(next);
                    loadSessions(next);
                  }}
                  className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded transition-all ${
                    adminMode
                      ? 'bg-yellow-500/20 text-yellow-300'
                      : 'text-blue-300/40 hover:text-blue-200'
                  }`}
                  title={adminMode ? 'Switch to My Chats' : 'View All Users'}
                >
                  {adminMode ? 'ADMIN' : 'ADMIN'}
                </button>
              )}
            </div>
            {loadingSessions && (
              <div className="px-4 py-2 text-xs text-blue-300/50">Loading...</div>
            )}
            {sessions.map(session => (
              <div
                key={session.id}
                className={`group flex items-center gap-1 px-3 py-2.5 rounded-lg cursor-pointer transition-all ${
                  session.id === activeSessionId
                    ? 'bg-white/10 text-white'
                    : 'text-blue-200 hover:text-white hover:bg-white/5'
                }`}
                onClick={() => handleSelectSession(session)}
              >
                <svg className="w-4 h-4 flex-shrink-0 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                {editingSessionId === session.id ? (
                  <input
                    ref={editInputRef}
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => handleRenameKeyDown(e, session.id)}
                    onBlur={() => renameSession(session.id, editTitle)}
                    className="flex-1 bg-white/10 text-white text-xs px-2 py-1 rounded outline-none min-w-0"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div className="flex-1 min-w-0">
                    <span className="text-xs truncate block">{session.title}</span>
                    {adminMode && session.user_email && (
                      <span className="text-[9px] text-blue-300/40 truncate block">{session.user_email.split('@')[0]}</span>
                    )}
                  </div>
                )}
                {/* Action buttons - visible on hover */}
                <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingSessionId(session.id);
                      setEditTitle(session.title);
                    }}
                    className="p-1 hover:bg-white/10 rounded"
                    title="Rename"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteSession(session.id);
                    }}
                    className="p-1 hover:bg-red-500/20 rounded text-red-300"
                    title="Delete"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
            {!loadingSessions && sessions.length === 0 && (
              <div className="px-4 py-3 text-xs text-blue-300/30 text-center">No saved chats yet</div>
            )}
          </div>
        )}

        {/* Fallback if no chat history — just show active chat button */}
        {(!chatHistoryEnabled || sidebarCollapsed) && (
          <div className="flex-1 px-2">
            <button className="w-full flex items-center gap-3 px-4 py-3 text-sm nav-active text-white bg-white/10 rounded-lg">
              <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              {!sidebarCollapsed && <span className="font-medium">Chat</span>}
            </button>
          </div>
        )}

        {/* Admin Dashboard nav */}
        {isAdmin && (
          <div className="px-2 pb-1">
            <button
              onClick={() => setViewMode(viewMode === 'admin' ? 'chat' : 'admin')}
              className={`w-full flex items-center gap-3 px-4 py-3 text-sm rounded-lg transition-all ${
                viewMode === 'admin'
                  ? 'nav-active text-white bg-white/10'
                  : 'text-blue-200 hover:text-white hover:bg-white/5'
              }`}
            >
              <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              {!sidebarCollapsed && <span className="font-medium">Admin Dashboard</span>}
            </button>
          </div>
        )}

        {/* Version tag */}
        {!sidebarCollapsed && (
          <div className="px-4 py-2 text-center">
            <span className="text-[10px] font-mono text-blue-300/50">V1.1.0</span>
          </div>
        )}

        {/* Sign out */}
        <div className="p-4 border-t border-white/10">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm text-blue-200 hover:text-white hover:bg-white/5 rounded-lg transition-all"
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            {!sidebarCollapsed && <span className="font-medium">Sign Out</span>}
          </button>
        </div>

        {/* Collapse toggle */}
        <div className="p-2 border-t border-white/10">
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="w-full flex items-center justify-center py-2 text-blue-300/50 hover:text-white transition-colors"
          >
            <svg className={`w-4 h-4 transition-transform ${sidebarCollapsed ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div>
              <h2 className="text-xl font-bold text-slate-800">
                {viewMode === 'admin' ? 'Admin Dashboard' : 'M2M Assistant'}
              </h2>
              <p className="text-xs text-slate-400">
                {viewMode === 'admin' ? 'View all user sessions and SQL queries' : 'Ask questions about your M2M ERP data in plain English'}
              </p>
            </div>
            {userCompanies.length > 1 && (
              <div className="flex bg-slate-100 rounded-lg p-1">
                {userCompanies.map(company => (
                  <button
                    key={company.id}
                    onClick={() => {
                      if (company.id !== activeCompanyId) {
                        setActiveCompanyId(company.id);
                        handleNewChat();
                      }
                    }}
                    className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-bold transition-all ${
                      company.id === activeCompanyId
                        ? 'bg-white text-mac-navy shadow-sm'
                        : 'text-slate-400 hover:text-slate-600'
                    }`}
                  >
                    <img src={company.logo} alt={company.shortName} className="w-5 h-5 object-contain" />
                    {company.shortName}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="text-[10px] font-mono text-slate-300 bg-slate-50 px-2 py-1 rounded">Powered by Gemini</span>
        </header>

        {/* Admin View */}
        {viewMode === 'admin' && isAdmin && (
          <AdminView
            chatSessionsUrl={CHAT_SESSIONS_URL}
            chatMessagesUrl={CHAT_MESSAGES_URL}
            currentUser={currentUser || ''}
          />
        )}

        {/* Chat area */}
        {viewMode === 'chat' && (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center view-transition">
                  <div className="w-16 h-16 mb-4">
                    <img src={activeCompany.logo} alt={activeCompany.name} className="w-full h-full object-contain opacity-20" />
                  </div>
                  <h3 className="text-lg font-bold text-slate-400 mb-2">What would you like to know?</h3>
                  <p className="text-sm text-slate-400 max-w-md mb-8">
                    Ask me anything about M2M data — sales orders, jobs, inventory, purchase orders, customers, and more.
                  </p>
                  <div className="grid grid-cols-2 gap-3 max-w-lg">
                    {[
                      'Show me all open sales orders',
                      'What jobs are active right now?',
                      'List inventory items with zero on hand',
                      'Show purchase orders due this month',
                    ].map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => { setInput(suggestion); inputRef.current?.focus(); }}
                        className="text-left p-3 bg-white rounded-xl border border-slate-200 text-sm text-slate-600 hover:border-mac-accent hover:text-mac-accent transition-all"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="max-w-4xl mx-auto space-y-4">
                  {messages.map((msg) => (
                    <div key={msg.id}>
                      <ChatMessage message={msg} logo={activeCompany.logo} />
                      {msg.role === 'assistant' && !msg.loading && !msg.error && msg.rows && msg.columns && (
                        <ResultsTable columns={msg.columns} rows={msg.rows} sql={msg.sql || ''} />
                      )}
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            {/* Input area */}
            <div className="border-t border-slate-200 bg-white px-6 py-4">
              <div className="max-w-4xl mx-auto flex gap-3">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about M2M data... (Enter to send, Shift+Enter for new line)"
                  rows={1}
                  className="flex-1 px-4 py-3 rounded-xl border border-slate-300 focus:border-mac-accent focus:ring-2 focus:ring-mac-accent/20 outline-none resize-none text-sm"
                  style={{ minHeight: '48px', maxHeight: '120px' }}
                  disabled={isLoading}
                />
                <button
                  onClick={handleSend}
                  disabled={isLoading || !input.trim()}
                  className="px-5 py-3 bg-mac-navy hover:bg-mac-blue text-white font-bold rounded-xl text-sm transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                  Send
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
