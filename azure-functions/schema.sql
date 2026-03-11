-- MAC M2M Assistant — Chat History Schema
-- Run this against the mac-m2m-assistant Azure SQL database

CREATE TABLE chat_sessions (
  id          UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  user_email  NVARCHAR(255)    NOT NULL,
  title       NVARCHAR(255)    NOT NULL DEFAULT 'New Chat',
  created_at  DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
  updated_at  DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

CREATE INDEX IX_chat_sessions_user ON chat_sessions (user_email, updated_at DESC);

CREATE TABLE chat_messages (
  id          UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  session_id  UNIQUEIDENTIFIER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        NVARCHAR(20)     NOT NULL,  -- 'user' or 'assistant'
  content     NVARCHAR(MAX)    NOT NULL,
  sql_query   NVARCHAR(MAX)    NULL,
  columns     NVARCHAR(MAX)    NULL,      -- JSON array of column names
  rows_data   NVARCHAR(MAX)    NULL,      -- JSON array of row objects
  row_count   INT              NULL,
  error       NVARCHAR(MAX)    NULL,
  created_at  DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

CREATE INDEX IX_chat_messages_session ON chat_messages (session_id, created_at ASC);
