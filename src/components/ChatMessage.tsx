import React from 'react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sql?: string;
  error?: string;
  loading?: boolean;
  adminSender?: string;
  feedback?: 'good' | 'bad' | null;
  cost?: { inputTokens: number; outputTokens: number; calls: number; cost: number };
}

interface ChatMessageProps {
  message: Message;
  logo?: string;
  isAdmin?: boolean;
  onFeedback?: (messageId: string, feedback: 'good' | 'bad') => void;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ message, logo = '/mac_logo.png', isAdmin = false, onFeedback }) => {
  const isUser = message.role === 'user';

  if (message.loading) {
    return (
      <div className="flex gap-3 view-transition">
        <div className="w-8 h-8 flex items-center justify-center flex-shrink-0">
          <img src={logo} alt="MAC" className="w-8 h-8 object-contain" />
        </div>
        <div className="bg-white rounded-lg px-4 py-3 border border-mauve-6 shadow-sm">
          <div className="flex gap-1.5">
            <div className="w-2 h-2 rounded-full bg-mac-navy typing-dot" />
            <div className="w-2 h-2 rounded-full bg-mac-navy typing-dot" />
            <div className="w-2 h-2 rounded-full bg-mac-navy typing-dot" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex gap-3 view-transition ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`w-8 h-8 flex items-center justify-center flex-shrink-0 ${
        isUser ? 'bg-mac-navy rounded-full' : ''
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
        <div className={`inline-block rounded-lg px-4 py-3 text-sm ${
          isUser
            ? 'bg-mac-navy text-white'
            : message.error
              ? 'bg-red-50 border border-red-200 text-red-700'
              : 'bg-white border border-mauve-6 text-mauve-12 shadow-sm'
        }`}>
          {/* Admin error diagnostics: render with monospace formatting */}
          {message.error && isAdmin && message.content.includes('\n') ? (
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed m-0">
              {message.content.replace(/^\[ADMIN:[^\]]+\]\s*/, '')}
            </pre>
          ) : (
            message.content.replace(/^\[ADMIN:[^\]]+\]\s*/, '')
          )}
        </div>

        {/* Admin badge */}
        {isUser && message.adminSender && (
          <div className="mt-1 flex items-center gap-1 justify-end">
            <span className="px-2 py-0.5 bg-amber-100 text-amber-700 border border-amber-200 rounded text-[9px] font-bold uppercase tracking-wider">
              Admin
            </span>
            <span className="text-[9px] text-mauve-9">{message.adminSender.split('@')[0]}</span>
          </div>
        )}

        {/* Per-message cost (admin only) */}
        {!isUser && isAdmin && message.cost && (
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[9px] font-mono text-emerald-600 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded">
              ${message.cost.cost.toFixed(6)}
            </span>
            <span className="text-[9px] text-mauve-9">
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
              <summary className="text-[10px] text-mauve-9 cursor-pointer hover:text-mac-navy font-bold uppercase tracking-wider">
                View SQL Query
              </summary>
              <pre className="mt-1 p-3 bg-mauve-12 text-green-400 rounded-lg text-xs overflow-x-auto font-mono">
                {message.sql}
              </pre>
            </details>
          </div>
        )}

        {/* Feedback buttons — thumbs up/down on assistant messages with results */}
        {!isUser && !message.loading && !message.error && message.sql && onFeedback && (
          <div className="mt-2 flex items-center gap-1">
            {message.feedback ? (
              <span className="text-[10px] text-mauve-9">
                {message.feedback === 'good' ? 'Marked helpful' : 'Marked unhelpful'}
              </span>
            ) : (
              <>
                <span className="text-[10px] text-mauve-9 mr-1">Was this helpful?</span>
                <button
                  onClick={() => onFeedback(message.id, 'good')}
                  className="p-1 rounded hover:bg-green-50 text-mauve-9 hover:text-green-600 transition-colors"
                  title="Good result"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
                  </svg>
                </button>
                <button
                  onClick={() => onFeedback(message.id, 'bad')}
                  className="p-1 rounded hover:bg-red-50 text-mauve-9 hover:text-red-600 transition-colors"
                  title="Bad result"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5" />
                  </svg>
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
