import React, { useState, useEffect, useRef } from 'react';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { loginRequest, ALLOWED_DOMAIN } from './authConfig';
import { Login } from './components/Login';
import { ChatMessage } from './components/ChatMessage';
import { ResultsTable } from './components/ResultsTable';

const M2M_QUERY_URL = import.meta.env.VITE_M2M_QUERY_URL || '';

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

  const handleLogout = async () => {
    await instance.logoutPopup();
    setCurrentUser(null);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

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
        body: JSON.stringify({ message: text, history }),
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
    } catch (err: any) {
      setMessages(prev =>
        prev.map(m =>
          m.id === loadingMsg.id
            ? { ...m, loading: false, content: `Error: ${err.message}`, error: err.message }
            : m
        )
      );
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
    setInput('');
    inputRef.current?.focus();
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
            <div className="w-10 h-10 flex items-center justify-center flex-shrink-0">
              <img src="/mac_logo.png" alt="MAC Logo" className="w-full h-full object-contain" />
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

        {/* Chat nav - active */}
        <div className="flex-1 px-2">
          <button className="w-full flex items-center gap-3 px-4 py-3 text-sm nav-active text-white bg-white/10 rounded-lg">
            <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            {!sidebarCollapsed && <span className="font-medium">Chat</span>}
          </button>
        </div>

        {/* Version tag */}
        {!sidebarCollapsed && (
          <div className="px-4 py-2 text-center">
            <span className="text-[10px] font-mono text-blue-300/50">V1.0.0</span>
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
          <div>
            <h2 className="text-xl font-bold text-slate-800">M2M Assistant</h2>
            <p className="text-xs text-slate-400">Ask questions about your M2M ERP data in plain English</p>
          </div>
          <span className="text-[10px] font-mono text-slate-300 bg-slate-50 px-2 py-1 rounded">Powered by Gemini</span>
        </header>

        {/* Chat area */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center view-transition">
              <div className="w-16 h-16 mb-4">
                <img src="/mac_logo.png" alt="MAC Logo" className="w-full h-full object-contain opacity-20" />
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
                  <ChatMessage message={msg} />
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
      </main>
    </div>
  );
}

export default App;
