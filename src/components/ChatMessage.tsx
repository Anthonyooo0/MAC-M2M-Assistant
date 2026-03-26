import React from 'react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sql?: string;
  error?: string;
  loading?: boolean;
  adminSender?: string;
  cost?: { inputTokens: number; outputTokens: number; calls: number; cost: number };
}

interface ChatMessageProps {
  message: Message;
  logo?: string;
  isAdmin?: boolean;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ message, logo = '/mac_logo.png', isAdmin = false }) => {
  const isUser = message.role === 'user';

  if (message.loading) {
    return (
      <div className="flex gap-3 view-transition">
        <div className="w-8 h-8 flex items-center justify-center flex-shrink-0">
          <img src={logo} alt="MAC" className="w-8 h-8 object-contain" />
        </div>
        <div className="bg-white rounded-xl px-4 py-3 border border-slate-200 shadow-sm">
          <div className="flex gap-1.5">
            <div className="w-2 h-2 rounded-full bg-mac-accent typing-dot" />
            <div className="w-2 h-2 rounded-full bg-mac-accent typing-dot" />
            <div className="w-2 h-2 rounded-full bg-mac-accent typing-dot" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex gap-3 view-transition ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`w-8 h-8 flex items-center justify-center flex-shrink-0 ${
        isUser ? 'bg-mac-accent rounded-full' : ''
      }`}>
        {isUser ? (
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        ) : (
          <img src={logo} alt="MAC" className="w-8 h-8 object-contain" />
        )}
      </div>

      <div className={`max-w-[80%] ${isUser ? 'text-right' : ''}`}>
        <div className={`inline-block rounded-xl px-4 py-3 text-sm ${
          isUser
            ? 'bg-mac-navy text-white'
            : message.error
              ? 'bg-red-50 border border-red-200 text-red-700'
              : 'bg-white border border-slate-200 text-slate-700 shadow-sm'
        }`}>
          {message.content.replace(/^\[ADMIN:[^\]]+\]\s*/, '')}
        </div>

        {/* Admin badge */}
        {isUser && message.adminSender && (
          <div className="mt-1 flex items-center gap-1 justify-end">
            <span className="px-2 py-0.5 bg-amber-100 text-amber-700 border border-amber-200 rounded text-[9px] font-bold uppercase tracking-wider">
              Admin
            </span>
            <span className="text-[9px] text-slate-400">{message.adminSender.split('@')[0]}</span>
          </div>
        )}

        {/* Per-message cost (admin only) */}
        {!isUser && isAdmin && message.cost && (
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[9px] font-mono text-emerald-600 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded">
              ${message.cost.cost.toFixed(6)}
            </span>
            <span className="text-[9px] text-slate-400">
              {message.cost.inputTokens.toLocaleString()}in / {message.cost.outputTokens.toLocaleString()}out
            </span>
            {message.cost.calls > 1 && (
              <span className="text-[9px] text-amber-500 font-bold">{message.cost.calls} calls (retried)</span>
            )}
          </div>
        )}

        {/* Show SQL query */}
        {message.sql && !message.error && (
          <div className="mt-2">
            <details className="group">
              <summary className="text-[10px] text-slate-400 cursor-pointer hover:text-mac-accent font-bold uppercase tracking-wider">
                View SQL Query
              </summary>
              <pre className="mt-1 p-3 bg-slate-900 text-green-400 rounded-lg text-xs overflow-x-auto font-mono">
                {message.sql}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
};
