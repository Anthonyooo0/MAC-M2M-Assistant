import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { ALLOWED_DOMAINS } from './authConfig';
import { Login } from './components/Login';
import { ChatMessage } from './components/ChatMessage';
import { ResultsTable } from './components/ResultsTable';
import { AdminView } from './components/AdminView';
import { CostDashboard } from './components/CostDashboard';
import { QueryBuilder, type BuilderPayload } from './components/QueryBuilder';

const M2M_QUERY_URL = import.meta.env.VITE_M2M_QUERY_URL || '';
const CHAT_SESSIONS_URL = import.meta.env.VITE_CHAT_SESSIONS_URL || '';
const CHAT_MESSAGES_URL = import.meta.env.VITE_CHAT_MESSAGES_URL || '';
const QUERY_COSTS_URL = import.meta.env.VITE_QUERY_COSTS_URL || '';
const SCHEMA_META_URL = import.meta.env.VITE_SCHEMA_META_URL || '';
// Activity report shares the function app's host + key with m2m-query, so
// derive its URL rather than needing a separate env var.
const ACTIVITY_REPORT_URL = M2M_QUERY_URL.replace('/m2m-query', '/activity-report');

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sql?: string;
  columns?: string[];
  columnSources?: Record<string, { expression: string; tables: string[] }> | null;
  rows?: Record<string, any>[];
  rowCount?: number;
  error?: string;
  loading?: boolean;
  adminSender?: string; // set when an admin sends a message in another user's chat
  feedback?: 'good' | 'bad' | null;
  cost?: { inputTokens: number; outputTokens: number; calls: number; cost: number };
}

interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  user_email?: string;  // populated in admin mode
  database_name?: string; // which database this chat is for
}

const ADMIN_EMAILS = ['anthony.jimenez@macproducts.net', 'juan.ortiz@macproducts.net', 'jerson.fulgencio@macproducts.net'];

// Users (besides admins) who see the gated aluminum-inventory preset.
const ALUMINUM_PRESET_USERS = ['nick.costantino@macproducts.net', 'rachel.amaro@macproducts.net'];

// Builds the user-facing message that gets shown in the chat bubble when a
// Builder-mode submission is sent. The actual SQL constraints are sent in the
// builder payload — this is just what the user sees of their own request.
function buildBuilderSummary(payload: BuilderPayload): string {
  const parts: string[] = [];
  if (payload.tables.length > 0) {
    parts.push(`Sources: ${payload.tables.join(', ')}`);
  }
  if (payload.columns.length > 0) {
    const sample = payload.columns.slice(0, 6).join(', ');
    const more = payload.columns.length > 6 ? ` (+${payload.columns.length - 6} more)` : '';
    parts.push(`Fields: ${sample}${more}`);
  }
  if (payload.filters.length > 0) {
    parts.push(`Conditions: ${payload.filters.length}`);
  }
  if (payload.clarifier) {
    parts.push(`Clarifier: ${payload.clarifier}`);
  }
  return `[Builder] ${parts.join(' · ')}`;
}

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
  { id: 'unipoint', name: 'UniPoint Quality', shortName: 'UNIPOINT', logo: '/UniPointlogo.png', database: 'unipoint_live' },
];

// Map of users who have access to specific companies (by email → company IDs)
// Users not in this map get MAC Products only by default
const MULTI_COMPANY_USERS: Record<string, string[]> = {
  'henry.russnow@macproducts.net': ['mac-products', 'mac-impulse'],
  'anthony.jimenez@macproducts.net': ['mac-products', 'mac-impulse', 'unipoint'],
  'juan.ortiz@macproducts.net': ['mac-products', 'mac-impulse', 'unipoint'],
  'edward.russnow@macproducts.net': ['mac-products', 'mac-impulse'],
  'chirag.patel@macproducts.net': ['mac-products', 'unipoint'],
};

function App() {
  const { instance, accounts } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const sendLockRef = useRef(false); // Synchronous guard — prevents duplicate API calls
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
  const [viewMode, setViewMode] = useState<'chat' | 'admin' | 'costs'>('chat');
  // Message cache — avoids re-fetching when clicking between sessions
  const messageCacheRef = useRef<Record<string, Message[]>>({});
  // Input mode — chat (natural language) vs. builder (visual table/column picker)
  const [inputMode, setInputMode] = useState<'chat' | 'builder'>('chat');

  // Company/tenant state
  const defaultCompany = (currentUser || '').endsWith('@macimpulse.net') ? ['mac-impulse'] : ['mac-products'];
  const userCompanyIds = MULTI_COMPANY_USERS[currentUser || ''] || defaultCompany;
  const userCompanies = COMPANIES.filter(c => userCompanyIds.includes(c.id));
  const [activeCompanyId, setActiveCompanyId] = useState('mac-products');
  const activeCompany = COMPANIES.find(c => c.id === activeCompanyId) || COMPANIES[0];

  const chatHistoryEnabled = !!CHAT_SESSIONS_URL && !!CHAT_MESSAGES_URL;
  const isAdmin = ADMIN_EMAILS.includes(currentUser || '');
  const [appReady, setAppReady] = useState(false);
  const [selectedModel, setSelectedModel] = useState<'claude-sonnet' | 'claude-opus'>('claude-sonnet');

  useEffect(() => {
    if (isAuthenticated && accounts.length > 0) {
      const email = accounts[0].username?.toLowerCase() || '';
      if (ALLOWED_DOMAINS.some(domain => email.endsWith(`@${domain}`))) {
        setCurrentUser(email);
      }
    }
  }, [isAuthenticated, accounts]);

  useEffect(() => {
    if (currentUser && currentUser.endsWith('@macimpulse.net')) {
      setActiveCompanyId('mac-impulse');
    }
  }, [currentUser]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Tracks whether the initial sessions fetch failed after all retries — when
  // true the sidebar shows "Reconnecting…" instead of "No saved chats yet".
  const [sessionsLoadFailed, setSessionsLoadFailed] = useState(false);

  // Load sessions when user logs in, then mark app as ready.
  // Azure Function cold-start can take 5-15s; retry up to 3 times with
  // exponential backoff (2s, 5s, 10s) so a cold function doesn't show
  // a misleading empty state.
  useEffect(() => {
    if (!currentUser || !chatHistoryEnabled) {
      if (currentUser) setAppReady(true);
      return;
    }
    let cancelled = false;
    const url = `${CHAT_SESSIONS_URL}&userEmail=${encodeURIComponent(currentUser)}${adminMode && isAdmin ? '&admin=true' : ''}`;
    const delays = [0, 2000, 5000, 10000]; // 4 attempts total

    const tryFetch = async (attempt: number): Promise<void> => {
      if (cancelled) return;
      if (delays[attempt] > 0) {
        await new Promise(r => setTimeout(r, delays[attempt]));
        if (cancelled) return;
      }
      try {
        const res = await fetch(url);
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          if (cancelled) return;
          setSessions(Array.isArray(data) ? data : []);
          setSessionsLoadFailed(false);
          setAppReady(true);
          return;
        }
      } catch (_e) { /* fall through to retry */ }

      if (attempt + 1 < delays.length) {
        return tryFetch(attempt + 1);
      }
      // Out of retries — surface the failure so UI can prompt a reconnect
      if (!cancelled) {
        setSessionsLoadFailed(true);
        setAppReady(true);
      }
    };

    setSessionsLoadFailed(false);
    tryFetch(0);
    return () => { cancelled = true; };
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
        setSessionsLoadFailed(false);
      } else {
        setSessionsLoadFailed(true);
      }
    } catch (err) {
      console.error('Failed to load sessions:', err);
      setSessionsLoadFailed(true);
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
        body: JSON.stringify({ userEmail: currentUser, database: activeCompany.database, companyName: activeCompany.name }),
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

  const saveMessages = useCallback((sessionId: string, msgs: Message[]) => {
    if (!chatHistoryEnabled) return;
    // Fire-and-forget — don't block the UI waiting for the save
    fetch(CHAT_MESSAGES_URL, {
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
          adminSender: m.adminSender,
        })),
      }),
    }).then(res => {
      if (res.ok) return res.json();
    }).then(data => {
      if (data?.title) {
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, title: data.title, updated_at: new Date().toISOString() } : s
        ));
      }
    }).catch(err => console.error('Failed to save messages:', err));
  }, []);

  const loadSessionMessages = useCallback(async (sessionId: string) => {
    if (!chatHistoryEnabled) return;
    // Check cache first — instant switch between already-loaded sessions
    const cached = messageCacheRef.current[sessionId];
    if (cached) {
      setMessages(cached);
      setActiveSessionId(sessionId);
      return;
    }
    // Show loading state while fetching
    setActiveSessionId(sessionId);
    setMessages([]);
    setIsLoading(true);
    try {
      const res = await fetch(`${CHAT_MESSAGES_URL}&sessionId=${encodeURIComponent(sessionId)}`);
      if (res.ok) {
        const data = await res.json();
        messageCacheRef.current[sessionId] = data;
        setMessages(data);
      }
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const renameSession = useCallback((sessionId: string, title: string) => {
    if (!chatHistoryEnabled) return;
    // Optimistic — update UI immediately
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title } : s));
    setEditingSessionId(null);
    fetch(CHAT_SESSIONS_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, title }),
    }).catch(err => console.error('Failed to rename session:', err));
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    if (!chatHistoryEnabled) return;
    // Optimistic — update UI immediately, persist in background
    delete messageCacheRef.current[sessionId];
    setSessions(prev => prev.filter(s => s.id !== sessionId));
    if (activeSessionId === sessionId) {
      setActiveSessionId(null);
      setMessages([]);
    }
    fetch(`${CHAT_SESSIONS_URL}&sessionId=${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }).catch(err => console.error('Failed to delete session:', err));
  }, [activeSessionId]);

  const handleLogout = async () => {
    await instance.logoutPopup();
    setCurrentUser(null);
  };

  // Shared core for Chat, Builder, and Raw-SQL preset submissions. Caller
  // provides the user-facing message text (what's shown in the bubble) and
  // an optional extra payload. When `rawSql` is provided the backend skips
  // the clarifier + LLM and runs the SQL directly through the existing
  // safety/schema/exec pipeline — used by clickable presets that need a
  // deterministic result every click.
  const submitQuery = async (
    userText: string,
    extraPayload?: { mode?: 'builder'; builder?: BuilderPayload; rawSql?: string; activityReport?: boolean },
    urlOverride?: string
  ) => {
    if (!userText || isLoading || sendLockRef.current) return;
    sendLockRef.current = true;

    let sessionId = activeSessionId;
    if (!sessionId && chatHistoryEnabled) {
      sessionId = await createSession();
      if (sessionId) setActiveSessionId(sessionId);
    }

    const activeSession = sessions.find(s => s.id === sessionId);
    const isAdminInOtherChat = isAdmin && adminMode && activeSession?.user_email && activeSession.user_email !== currentUser;

    const adminTag = isAdminInOtherChat ? `[ADMIN:${currentUser}] ` : '';
    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: adminTag + userText,
      ...(isAdminInOtherChat ? { adminSender: currentUser || undefined } : {}),
    };

    const loadingMsg: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '',
      loading: true,
    };

    setMessages(prev => [...prev, userMsg, loadingMsg]);
    setIsLoading(true);

    try {
      const history = messages
        .filter(m => !m.loading)
        .slice(-8)
        .map(m => ({
          role: m.role === 'user' ? 'user' : 'model',
          // Include the SQL the assistant actually ran, so a follow-up that
          // refers to a prior result ("those 1,722 parts", "that list") can
          // reuse the exact query/filter instead of the model re-deriving a
          // different one from the prose (which drifts — e.g. 1,722 -> 1,835).
          content: m.role === 'user'
            ? m.content
            : (m.sql ? `${m.content}\n\n[SQL I ran for this answer]:\n${m.sql}` : m.content),
        }));

      const res = await fetch(urlOverride || M2M_QUERY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userText,
          history,
          database: activeCompany.database,
          userEmail: currentUser,
          sessionId,
          model: selectedModel,
          ...(extraPayload || {}),
        }),
      });

      const data = await res.json();

      const explanation = data.explanation || '';
      let content = '';
      if (data.error) {
        if (isAdmin) {
          // Admin: full diagnostic view
          const diag = [
            `Error: ${data.error}`,
            data.sql ? `\nSQL: ${data.sql}` : null,
            data._requestId ? `\nRequest ID: ${data._requestId}` : null,
            `\nHTTP Status: ${res.status}`,
            data._cost ? `\nAPI Calls: ${data._cost.calls} | Model: ${data._cost.model || 'gemini'} | Tokens: ${data._cost.inputTokens}in / ${data._cost.outputTokens}out | Cost: $${data._cost.cost?.toFixed(6)}` : null,
            data._cost?.confidence != null ? `\nConfidence: ${data._cost.confidence}` : null,
          ].filter(Boolean).join('');
          content = diag;
        } else {
          // User: friendly message
          content = 'Something went wrong processing your request. Please try rephrasing your question or try again in a moment.';
        }
      } else if (data.sql && data.rowCount === 0) {
        content = explanation
          ? `${explanation}\n\nThe query ran successfully but returned no results. Try broadening your search criteria.`
          : 'The query ran successfully but returned no results. Try broadening your search criteria.';
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
        columnSources: data.columnSources,
        rows: data.rows,
        rowCount: data.rowCount,
        error: data.error,
        cost: data._cost,
      };

      setMessages(prev => {
        const updated = prev.map(m => m.id === loadingMsg.id ? assistantMsg : m);
        if (sessionId) messageCacheRef.current[sessionId] = updated;
        return updated;
      });

      // Save to Azure SQL
      if (sessionId && chatHistoryEnabled) {
        saveMessages(sessionId, [userMsg, assistantMsg]);
      }
    } catch (err: any) {
      const userContent = 'Unable to reach the server. Please check your connection and try again.';
      const adminContent = [
        `Network Error: ${err.message}`,
        `\nType: ${err.name || 'Unknown'}`,
        `\nEndpoint: ${M2M_QUERY_URL?.split('?')[0] || 'not set'}`,
        `\nDatabase: ${activeCompany.database}`,
        `\nTimestamp: ${new Date().toISOString()}`,
        err.cause ? `\nCause: ${JSON.stringify(err.cause)}` : null,
      ].filter(Boolean).join('');

      const errorMsg: Message = {
        id: loadingMsg.id,
        role: 'assistant',
        content: isAdmin ? adminContent : userContent,
        error: err.message,
      };
      setMessages(prev => {
        const updated = prev.map(m => m.id === loadingMsg.id ? errorMsg : m);
        if (sessionId) messageCacheRef.current[sessionId] = updated;
        return updated;
      });

      if (sessionId && chatHistoryEnabled) {
        saveMessages(sessionId, [userMsg, errorMsg]);
      }
    } finally {
      setIsLoading(false);
      sendLockRef.current = false; // Release lock
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await submitQuery(text);
  };

  const handleBuilderSubmit = async (payload: BuilderPayload) => {
    const summary = buildBuilderSummary(payload);
    await submitQuery(summary, { mode: 'builder', builder: payload });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFeedback = useCallback(async (messageId: string, feedback: 'good' | 'bad') => {
    // Optimistic update
    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, feedback } : m));
    // Update cache
    if (activeSessionId && messageCacheRef.current[activeSessionId]) {
      messageCacheRef.current[activeSessionId] = messageCacheRef.current[activeSessionId].map(
        m => m.id === messageId ? { ...m, feedback } : m
      );
    }
    // Persist to backend
    if (CHAT_MESSAGES_URL) {
      try {
        await fetch(CHAT_MESSAGES_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId, feedback }),
        });
      } catch (err) {
        console.error('Failed to save feedback:', err);
      }
    }
  }, [activeSessionId]);

  const handleNewChat = () => {
    setMessages([]);
    setActiveSessionId(null);
    setInput('');
    inputRef.current?.focus();
  };


  const handleSelectSession = (session: ChatSession) => {
    if (session.id === activeSessionId) return;
    // Auto-switch to the database this chat was created on
    if (session.database_name) {
      const company = COMPANIES.find(c => c.name === session.database_name);
      if (company) setActiveCompanyId(company.id);
    }
    loadSessionMessages(session.id);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent, sessionId: string) => {
    if (e.key === 'Enter') {
      renameSession(sessionId, editTitle);
    } else if (e.key === 'Escape') {
      setEditingSessionId(null);
    }
  };

  // Auth gate — must run first so currentUser is set before maintenance check
  if (!isAuthenticated || !currentUser) {
    if (isAuthenticated && accounts.length > 0) {
      const email = accounts[0].username?.toLowerCase() || '';
      if (!ALLOWED_DOMAINS.some(domain => email.endsWith(`@${domain}`))) {
        return (
          <div className="flex h-screen items-center justify-center bg-mauve-2">
            <div className="text-center">
              <p className="text-red-600 font-bold">Access denied. Only @macproducts.net and @macimpulse.net accounts allowed.</p>
              <button onClick={handleLogout} className="mt-4 px-4 py-2 bg-mac-navy text-white rounded-lg">Sign Out</button>
            </div>
          </div>
        );
      }
    }
    return <Login />;
  }

  // Maintenance mode — runs after auth so currentUser is available for bypass check
  const MAINTENANCE_MODE = false;
  const MAINTENANCE_BYPASS = ['anthony.jimenez@macproducts.net'];

  if (MAINTENANCE_MODE && !MAINTENANCE_BYPASS.includes(currentUser || '')) {
    return (
      <div className="flex h-screen items-center justify-center bg-mauve-2">
        <div className="text-center max-w-md">
          <div className="w-20 h-20 mx-auto mb-6">
            <img src="/mac_logo.png" alt="MAC Products" className="w-full h-full object-contain" />
          </div>
          <h1 className="text-2xl font-bold text-mauve-12 mb-3">Scheduled Maintenance</h1>
          <p className="text-mauve-11 text-sm leading-relaxed mb-6">
            The M2M Assistant is currently undergoing maintenance and upgrades.
            The system will be back online shortly. Thank you for your patience.
          </p>
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-amber-50 border border-amber-200 rounded-lg">
            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></div>
            <span className="text-amber-700 text-xs font-bold uppercase tracking-wider">Maintenance In Progress</span>
          </div>
        </div>
      </div>
    );
  }

  // Loading screen — wait for sessions and app data to be ready
  if (!appReady || loadingSessions) {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <div className="text-center">
          <div className="w-20 h-20 mx-auto mb-6">
            <img src="/mac_logo.png" alt="MAC Products" className="w-full h-full object-contain" />
          </div>
          <div className="flex justify-center mb-4">
            <div className="w-8 h-8 border-4 border-mauve-6 border-t-mac-navy rounded-full animate-spin"></div>
          </div>
          <p className="text-mauve-11 text-sm font-medium tracking-wide">Loading your workspace...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-mauve-2 font-sans">
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
                <p className="text-blue-200/70 text-[10px] truncate uppercase font-bold tracking-tighter">
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
              <span className="text-[10px] font-bold uppercase tracking-wider text-blue-200/60">
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
                      : 'text-blue-200/60 hover:text-blue-200'
                  }`}
                  title={adminMode ? 'Switch to My Chats' : 'View All Users'}
                >
                  {adminMode ? 'ADMIN' : 'ADMIN'}
                </button>
              )}
            </div>
            {loadingSessions && (
              <div className="px-4 py-2 text-xs text-blue-200/70">Loading...</div>
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
                      <span className="text-[9px] text-blue-200/60 truncate block">{session.user_email.split('@')[0]}</span>
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
            {!loadingSessions && sessions.length === 0 && !sessionsLoadFailed && (
              <div className="px-4 py-3 text-xs text-blue-200/40 text-center">No saved chats yet</div>
            )}
            {!loadingSessions && sessions.length === 0 && sessionsLoadFailed && (
              <div className="px-4 py-3 text-center space-y-2">
                <div className="flex items-center justify-center gap-2 text-xs text-yellow-300/70">
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Reconnecting...
                </div>
                <button
                  onClick={() => loadSessions()}
                  className="text-[10px] text-blue-200 hover:text-white underline"
                >
                  Retry now
                </button>
              </div>
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

        {/* Admin nav */}
        {isAdmin && (
          <div className="px-2 pb-1 space-y-1">
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
            <button
              onClick={() => setViewMode(viewMode === 'costs' ? 'chat' : 'costs')}
              className={`w-full flex items-center gap-3 px-4 py-3 text-sm rounded-lg transition-all ${
                viewMode === 'costs'
                  ? 'nav-active text-white bg-white/10'
                  : 'text-blue-200 hover:text-white hover:bg-white/5'
              }`}
            >
              <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {!sidebarCollapsed && <span className="font-medium">API Costs</span>}
            </button>
          </div>
        )}

        {/* Version tag */}
        {!sidebarCollapsed && (
          <div className="px-4 py-2 text-center">
            <span className="text-[10px] font-mono text-blue-200/50">V1.3.0</span>
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
            className="w-full flex items-center justify-center py-2 text-blue-200/60 hover:text-white transition-colors"
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
        <header className="bg-white border-b border-mauve-6 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div>
              <h2 className="text-xl font-bold text-mauve-12">
                {viewMode === 'admin' ? 'Admin Dashboard' : viewMode === 'costs' ? 'API Costs' : 'M2M Assistant'}
              </h2>
              <p className="text-xs text-mauve-9">
                {viewMode === 'admin' ? 'View all user sessions and SQL queries' : viewMode === 'costs' ? 'API usage and cost tracking' : 'Ask questions about your M2M ERP data in plain English'}
              </p>
            </div>
            {userCompanies.length > 1 && (
              <div className="flex bg-mauve-3 rounded-lg p-1">
                {userCompanies.map(company => {
                  const hasMessages = messages.length > 0;
                  const isActive = company.id === activeCompanyId;
                  const isLocked = hasMessages && !isActive;
                  return (
                  <button
                    key={company.id}
                    disabled={isLocked}
                    onClick={() => {
                      if (!isLocked && company.id !== activeCompanyId) {
                        setActiveCompanyId(company.id);
                        handleNewChat();
                      }
                    }}
                    className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-bold transition-all ${
                      isActive
                        ? 'bg-white text-mac-navy shadow-sm'
                        : isLocked
                          ? 'text-mauve-7 cursor-not-allowed'
                          : 'text-mauve-9 hover:text-mauve-11'
                    }`}
                  >
                    <img src={company.logo} alt={company.shortName} className="w-5 h-5 object-contain" />
                    {company.shortName}
                  </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isAdmin && (
              <span className="text-[10px] font-mono text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded">
                Session: ${messages.reduce((sum, m) => sum + (m.cost?.cost || 0), 0).toFixed(6)} ({messages.filter(m => m.cost).reduce((sum, m) => sum + (m.cost?.calls || 0), 0)} calls)
              </span>
            )}
            {/* Model toggle — Claude Sonnet (default) or Claude Opus. */}
            <div className="flex items-center bg-mauve-3 rounded-lg p-0.5">
              <button
                onClick={() => setSelectedModel('claude-sonnet')}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all ${
                  selectedModel === 'claude-sonnet'
                    ? 'bg-white text-orange-700 shadow-sm'
                    : 'text-mauve-9 hover:text-mauve-11'
                }`}
              >
                Claude Sonnet
              </button>
              <button
                onClick={() => setSelectedModel('claude-opus')}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all ${
                  selectedModel === 'claude-opus'
                    ? 'bg-white text-purple-700 shadow-sm'
                    : 'text-mauve-9 hover:text-mauve-11'
                }`}
              >
                Claude Opus
              </button>
            </div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-mauve-9">Powered by Claude Sonnet</span>
          </div>
        </header>

        {/* Admin View */}
        {viewMode === 'admin' && isAdmin && (
          <AdminView
            chatSessionsUrl={CHAT_SESSIONS_URL}
            chatMessagesUrl={CHAT_MESSAGES_URL}
            currentUser={currentUser || ''}
          />
        )}

        {/* Cost Dashboard */}
        {viewMode === 'costs' && isAdmin && (
          <CostDashboard costsUrl={QUERY_COSTS_URL} />
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
                  <h3 className="text-lg font-bold text-mauve-9 mb-2">What would you like to know?</h3>
                  <p className="text-sm text-mauve-9 max-w-md mb-8">
                    {activeCompany.id === 'unipoint'
                      ? 'Ask me anything about UniPoint quality data — inspections, NCRs, corrective actions, equipment, and more.'
                      : 'Ask me anything about M2M data — sales orders, jobs, inventory, purchase orders, customers, and more.'}
                  </p>
                  <div className="grid grid-cols-2 gap-3 max-w-lg">
                    {(activeCompany.id === 'unipoint' ? [
                      { label: 'Show me all open non-conformance reports', query: 'Show me all open non-conformance reports' },
                      { label: 'What corrective actions are in progress?', query: 'What corrective actions are in progress?' },
                      { label: 'List recent inspections', query: 'List recent inspections' },
                      { label: 'Show equipment maintenance due', query: 'Show equipment maintenance due' },
                    ] : [
                      { label: 'Show me all open sales orders', query: 'Show me all open sales orders' },
                      { label: 'What jobs are active right now?', query: 'What jobs are active right now?' },
                      { label: 'List inventory items with zero on hand', query: 'List inventory items with zero on hand' },
                      { label: 'Show purchase orders due this month', query: 'Show purchase orders due this month' },
                      // Presets added 2026-06-10: ship-to street audit. The
                      // rawSql field bypasses the clarifier + LLM at the
                      // backend so each click runs the exact same query
                      // deterministically.
                      {
                        label: 'Count open SOs missing ship-to street',
                        rawSql: "SELECT COUNT(*) AS MissingStreetAddress FROM somast WHERE fstatus = 'O' AND (fmstreet IS NULL OR LTRIM(RTRIM(fmstreet)) = '');",
                      },
                      // Note: original ask was SELECT *, but the safety
                      // check blocks star-selects, so we enumerate the
                      // SOMAST columns most useful for triaging a missing
                      // ship-to street. Same WHERE clause as the count.
                      {
                        label: 'Show open SOs missing ship-to street',
                        rawSql:
                          "SELECT FSONO, FCOMPANY, FCUSTNO, FSTATUS, FORDERDATE, FDUEDATE, " +
                          "FCUSTPONO, FESTIMATOR, FSOCOORD, FSOLDBY, FSHIPVIA, " +
                          "FSHPTOADDR, FSOLDADDR, FBILLADDR, FMSTREET " +
                          "FROM somast " +
                          "WHERE fstatus = 'O' " +
                          "AND (fmstreet IS NULL OR LTRIM(RTRIM(fmstreet)) = '');",
                      },
                      // Gated preset (Nick, Rachel, admins): aluminum stock on
                      // hand in the PPBLD1 location, with bin + last purchase.
                      {
                        label: 'Aluminum stock on hand — PPBLD1',
                        restrictedTo: ALUMINUM_PRESET_USERS,
                        rawSql:
                          `SELECT RTRIM(i.FPARTNO) AS "Part Number", RTRIM(m.FDESCRIPT) AS "Short Description", ` +
                          `m.FMUSRMEMO1 AS "Long Description", RTRIM(m.FMEASURE) AS "Unit of Measure", ` +
                          `i.FONHAND AS "Qty On Hand", RTRIM(i.FBINNO) AS "Bin", ` +
                          `v.FVLASTPD AS "Last Purchase Date", v.FVLASTPC AS "Last Purchase Cost" ` +
                          `FROM INONHD i JOIN INMASTX m ON RTRIM(i.FPARTNO) = RTRIM(m.FPARTNO) ` +
                          `LEFT JOIN INVEND v ON RTRIM(i.FPARTNO) = RTRIM(v.FPARTNO) AND v.FPRIORITY = '1' ` +
                          `WHERE RTRIM(i.FLOCATION) = 'PPBLD1' AND i.FONHAND <> 0 AND ` +
                          `(m.FMUSRMEMO1 LIKE '%aluminum%' OR m.FMUSRMEMO1 LIKE '%Aluminum%' OR m.FMUSRMEMO1 LIKE '%ALUMINUM%' OR ` +
                          `m.FDESCRIPT LIKE '%aluminum%' OR m.FDESCRIPT LIKE '%Aluminum%' OR m.FDESCRIPT LIKE '%ALUMINUM%') ` +
                          `ORDER BY RTRIM(i.FPARTNO)`,
                      },
                      // General preset: every item-master record that has a long
                      // description (FMUSRMEMO1), with rev/class/source/UOM.
                      {
                        label: 'Item master — parts with long description',
                        rawSql:
                          `SELECT RTRIM(FPARTNO) AS "Part Number", RTRIM(FREV) AS "Revision", ` +
                          `RTRIM(FDESCRIPT) AS "Short Description", FMUSRMEMO1 AS "Long Description", ` +
                          `RTRIM(FPRODCL) AS "Product Class", RTRIM(FSOURCE) AS "Source", ` +
                          `RTRIM(FMEASURE) AS "Unit of Measure" ` +
                          `FROM INMASTX ` +
                          `WHERE FMUSRMEMO1 IS NOT NULL AND RTRIM(FMUSRMEMO1) <> '' ` +
                          `ORDER BY FPARTNO`,
                      },
                      // Activity report (admins + Edward): who's been querying,
                      // read only from the app's own database — NOT M2M.
                      {
                        label: 'Activity report — who has been querying',
                        activityReport: true,
                        restrictedTo: ['edward.russnow@macproducts.net'],
                      },
                    ] as Array<{ label: string; query?: string; rawSql?: string; restrictedTo?: string[]; activityReport?: boolean }>)
                      .filter((s) => !s.restrictedTo || isAdmin || s.restrictedTo.includes(currentUser || ''))
                      .map((suggestion) => (
                      <button
                        key={suggestion.label}
                        onClick={() => {
                          if (suggestion.activityReport) {
                            // Activity report: auto-run against the app DB endpoint.
                            submitQuery(suggestion.label, {}, ACTIVITY_REPORT_URL);
                          } else if (suggestion.rawSql) {
                            // Raw-SQL preset: auto-execute, bypass the input box.
                            submitQuery(suggestion.label, { rawSql: suggestion.rawSql });
                          } else {
                            // Natural-language preset: prefill input, user reviews and sends.
                            setInput(suggestion.query || suggestion.label);
                            inputRef.current?.focus();
                          }
                        }}
                        className="text-left p-3 bg-white rounded-lg border border-mauve-6 text-sm text-mauve-11 hover:border-mac-accent hover:text-mac-navy transition-all"
                      >
                        {suggestion.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="max-w-4xl mx-auto space-y-4">
                  {messages.map((msg) => (
                    <div key={msg.id}>
                      <ChatMessage message={msg} logo={activeCompany.logo} isAdmin={isAdmin} onFeedback={handleFeedback} />
                      {msg.role === 'assistant' && !msg.loading && !msg.error && msg.rows && msg.columns && (
                        <ResultsTable columns={msg.columns} rows={msg.rows} sql={msg.sql || ''} columnSources={msg.columnSources || undefined} />
                      )}
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            {/* Input area */}
            <div className="border-t border-mauve-6 bg-white px-6 py-4">
              <div className="max-w-4xl mx-auto">
                {/* Mode toggle */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex bg-mauve-3 rounded-lg p-0.5">
                    <button
                      onClick={() => setInputMode('chat')}
                      className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all ${
                        inputMode === 'chat'
                          ? 'bg-white text-mac-navy shadow-sm'
                          : 'text-mauve-9 hover:text-mauve-11'
                      }`}
                    >
                      Chat
                    </button>
                    <button
                      onClick={() => setInputMode('builder')}
                      disabled={!SCHEMA_META_URL}
                      title={!SCHEMA_META_URL ? 'Builder is not configured (VITE_SCHEMA_META_URL missing)' : ''}
                      className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                        inputMode === 'builder'
                          ? 'bg-white text-mac-navy shadow-sm'
                          : 'text-mauve-9 hover:text-mauve-11'
                      }`}
                    >
                      Query Builder
                    </button>
                  </div>
                  <span className="text-[10px] text-mauve-9 italic">
                    {inputMode === 'chat'
                      ? 'Ask in plain English.'
                      : 'Pick the data sources and fields you want.'}
                  </span>
                </div>

                {inputMode === 'chat' ? (
                  <div className="flex gap-3">
                    <textarea
                      ref={inputRef}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Ask about M2M data... (Enter to send, Shift+Enter for new line)"
                      rows={1}
                      className="flex-1 px-4 py-3 rounded-lg border border-mauve-7 focus:border-mauve-8 focus:ring-0 outline-none resize-none text-sm"
                      style={{ minHeight: '48px', maxHeight: '120px' }}
                      disabled={isLoading}
                    />
                    <button
                      onClick={handleSend}
                      disabled={isLoading || !input.trim()}
                      className="px-5 py-3 bg-mac-navy hover:bg-mac-blue text-white font-bold rounded-lg text-sm transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                      </svg>
                      Send
                    </button>
                  </div>
                ) : (
                  <QueryBuilder
                    schemaMetaUrl={SCHEMA_META_URL}
                    database={activeCompany.database}
                    isLoading={isLoading}
                    onSubmit={handleBuilderSubmit}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
