import React from 'react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sql?: string;
  error?: string;
  loading?: boolean;
}

interface ChatMessageProps {
  message: Message;
  logo?: string;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ message, logo = '/mac_logo.png' }) => {
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
          {message.content}
        </div>

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
