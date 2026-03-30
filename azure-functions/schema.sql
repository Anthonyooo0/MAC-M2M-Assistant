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
  feedback    NVARCHAR(10)     NULL,      -- 'good', 'bad', or NULL (no feedback)
  created_at  DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

CREATE INDEX IX_chat_messages_session ON chat_messages (session_id, created_at ASC);

-- Cost tracking for API usage
CREATE TABLE query_costs (
  id              UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  session_id      UNIQUEIDENTIFIER NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  user_email      NVARCHAR(255)    NOT NULL,
  database_name   NVARCHAR(50)     NULL,
  input_tokens    INT              NOT NULL DEFAULT 0,
  output_tokens   INT              NOT NULL DEFAULT 0,
  gemini_calls    INT              NOT NULL DEFAULT 1,
  cost            FLOAT            NOT NULL DEFAULT 0,
  prompt_version  NVARCHAR(20)     NULL,
  request_id      NVARCHAR(36)     NULL,
  created_at      DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

-- Migration: add columns to existing tables
-- ALTER TABLE query_costs ADD prompt_version NVARCHAR(20) NULL;
-- ALTER TABLE query_costs ADD request_id NVARCHAR(36) NULL;
-- ALTER TABLE chat_messages ADD feedback NVARCHAR(10) NULL;

CREATE INDEX IX_query_costs_date ON query_costs (created_at DESC);
CREATE INDEX IX_query_costs_session ON query_costs (session_id);
CREATE INDEX IX_query_costs_user ON query_costs (user_email, created_at DESC);
