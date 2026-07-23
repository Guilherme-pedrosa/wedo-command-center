-- WeDo Operações: confirmação vinculada ao payload, idempotência e auditoria.
CREATE TABLE IF NOT EXISTS public.mcp_pending_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  confirmation_token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executing', 'completed', 'failed', 'expired')),
  expires_at timestamptz NOT NULL,
  request_id uuid NOT NULL,
  result_reference jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz
);

GRANT SELECT ON public.mcp_pending_actions TO authenticated;
GRANT ALL ON public.mcp_pending_actions TO service_role;

CREATE INDEX IF NOT EXISTS idx_mcp_pending_actions_user_status
  ON public.mcp_pending_actions (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_pending_actions_expires
  ON public.mcp_pending_actions (expires_at)
  WHERE status = 'pending';

ALTER TABLE public.mcp_pending_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own MCP pending actions" ON public.mcp_pending_actions;
CREATE POLICY "Users view own MCP pending actions"
  ON public.mcp_pending_actions
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.mcp_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('executing', 'completed', 'failed')),
  upstream_id text,
  response_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (user_id, tool_name, idempotency_key)
);

GRANT SELECT ON public.mcp_idempotency TO authenticated;
GRANT ALL ON public.mcp_idempotency TO service_role;

CREATE INDEX IF NOT EXISTS idx_mcp_idempotency_upstream
  ON public.mcp_idempotency (tool_name, upstream_id)
  WHERE upstream_id IS NOT NULL;

ALTER TABLE public.mcp_idempotency ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own MCP idempotency" ON public.mcp_idempotency;
CREATE POLICY "Users view own MCP idempotency"
  ON public.mcp_idempotency
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.mcp_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email text,
  role text,
  tool_name text NOT NULL,
  operation_type text NOT NULL CHECK (operation_type IN ('read', 'prepare', 'write')),
  source_system text NOT NULL CHECK (source_system IN ('gestaoclick', 'auvo', 'supabase', 'multiple')),
  target_entity text,
  target_id text,
  parameters_sanitized jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_status text NOT NULL CHECK (result_status IN ('success', 'error')),
  upstream_status integer,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  error_code text,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.mcp_audit_log TO authenticated;
GRANT ALL ON public.mcp_audit_log TO service_role;

CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_user_created
  ON public.mcp_audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_tool_created
  ON public.mcp_audit_log (tool_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_request
  ON public.mcp_audit_log (request_id);

ALTER TABLE public.mcp_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own MCP audit" ON public.mcp_audit_log;
CREATE POLICY "Users view own MCP audit"
  ON public.mcp_audit_log
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  );

COMMENT ON TABLE public.mcp_pending_actions IS
  'Ações preparadas pelo MCP; confirmação curta e vinculada ao usuário e ao hash do payload.';
COMMENT ON TABLE public.mcp_idempotency IS
  'Chaves consumidas por gravações MCP para impedir repetição de ações.';
COMMENT ON TABLE public.mcp_audit_log IS
  'Auditoria sanitizada de consultas, preparações e gravações executadas pelo MCP.';