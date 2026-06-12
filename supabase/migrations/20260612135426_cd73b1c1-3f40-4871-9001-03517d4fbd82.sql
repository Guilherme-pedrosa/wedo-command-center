
-- ============================================================
-- AUDIT TRAIL: tabela central + função genérica + triggers
-- ============================================================

-- 1) Tabela
CREATE TABLE IF NOT EXISTS public.audit_trail (
  id            bigserial PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  user_id       uuid,
  user_email    text,
  user_role     text,
  action_type   text NOT NULL,            -- 'auth' | 'data' | 'business'
  action        text NOT NULL,            -- ex: 'INSERT','UPDATE','DELETE','login','logout','user_created','role_changed','negociacao_executada'...
  table_name    text,
  record_id     text,
  before_data   jsonb,
  after_data    jsonb,
  diff          jsonb,                    -- somente campos alterados (UPDATE)
  context       jsonb,                    -- {route, ip, user_agent, source}
  severity      text NOT NULL DEFAULT 'info' -- info|warning|critical
);

CREATE INDEX IF NOT EXISTS idx_audit_trail_created_at ON public.audit_trail (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trail_user_id ON public.audit_trail (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trail_table_record ON public.audit_trail (table_name, record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trail_action_type ON public.audit_trail (action_type, action, created_at DESC);

-- 2) Grants
GRANT SELECT, INSERT ON public.audit_trail TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.audit_trail_id_seq TO authenticated;
GRANT ALL ON public.audit_trail TO service_role;
GRANT ALL ON SEQUENCE public.audit_trail_id_seq TO service_role;

-- 3) RLS
ALTER TABLE public.audit_trail ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins veem todos os logs" ON public.audit_trail;
CREATE POLICY "Admins veem todos os logs"
ON public.audit_trail FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Service role gerencia logs" ON public.audit_trail;
CREATE POLICY "Service role gerencia logs"
ON public.audit_trail FOR ALL TO service_role
USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Usuários autenticados inserem logs" ON public.audit_trail;
CREATE POLICY "Usuários autenticados inserem logs"
ON public.audit_trail FOR INSERT TO authenticated
WITH CHECK (true);

-- 4) RPC para log de auth/business a partir do frontend/edge functions
CREATE OR REPLACE FUNCTION public.log_audit_event(
  _action_type text,
  _action      text,
  _table_name  text DEFAULT NULL,
  _record_id   text DEFAULT NULL,
  _before      jsonb DEFAULT NULL,
  _after       jsonb DEFAULT NULL,
  _context     jsonb DEFAULT NULL,
  _severity    text DEFAULT 'info'
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id    bigint;
  v_email text;
  v_role  text;
  v_diff  jsonb;
BEGIN
  SELECT email INTO v_email FROM public.profiles WHERE id = auth.uid();
  SELECT string_agg(role::text, ',') INTO v_role FROM public.user_roles WHERE user_id = auth.uid();

  IF _before IS NOT NULL AND _after IS NOT NULL THEN
    SELECT jsonb_object_agg(key, jsonb_build_object('before', _before->key, 'after', _after->key))
    INTO v_diff
    FROM (
      SELECT key FROM jsonb_object_keys(_after) AS key
      WHERE _before->key IS DISTINCT FROM _after->key
    ) t;
  END IF;

  INSERT INTO public.audit_trail (
    user_id, user_email, user_role,
    action_type, action,
    table_name, record_id,
    before_data, after_data, diff,
    context, severity
  ) VALUES (
    auth.uid(), v_email, v_role,
    _action_type, _action,
    _table_name, _record_id,
    _before, _after, v_diff,
    _context, COALESCE(_severity,'info')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_audit_event(text,text,text,text,jsonb,jsonb,jsonb,text) TO authenticated, service_role;

-- 5) Trigger genérica para INSERT/UPDATE/DELETE
CREATE OR REPLACE FUNCTION public.fn_audit_trail_generic()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id  uuid := auth.uid();
  v_email    text;
  v_role     text;
  v_before   jsonb;
  v_after    jsonb;
  v_diff     jsonb;
  v_record_id text;
BEGIN
  -- Captura identidade do usuário (pode ser NULL em chamadas service_role)
  IF v_user_id IS NOT NULL THEN
    SELECT email INTO v_email FROM public.profiles WHERE id = v_user_id;
    SELECT string_agg(role::text, ',') INTO v_role FROM public.user_roles WHERE user_id = v_user_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_before := to_jsonb(OLD);
    v_record_id := COALESCE((v_before->>'id'), (v_before->>'gc_id'), '');
  ELSIF TG_OP = 'INSERT' THEN
    v_after := to_jsonb(NEW);
    v_record_id := COALESCE((v_after->>'id'), (v_after->>'gc_id'), '');
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
    v_record_id := COALESCE((v_after->>'id'), (v_after->>'gc_id'), '');

    -- Calcula apenas campos alterados
    SELECT jsonb_object_agg(key, jsonb_build_object('before', v_before->key, 'after', v_after->key))
    INTO v_diff
    FROM (
      SELECT key FROM jsonb_object_keys(v_after) AS key
      WHERE (v_before->key) IS DISTINCT FROM (v_after->key)
        AND key NOT IN ('updated_at','sync_at','last_sync','last_updated_at')
    ) t;

    -- Se só mudou metadado, não loga
    IF v_diff IS NULL OR v_diff = '{}'::jsonb THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO public.audit_trail (
    user_id, user_email, user_role,
    action_type, action,
    table_name, record_id,
    before_data, after_data, diff,
    severity
  ) VALUES (
    v_user_id, v_email, v_role,
    'data', TG_OP,
    TG_TABLE_NAME, NULLIF(v_record_id,''),
    v_before, v_after, v_diff,
    CASE WHEN TG_OP = 'DELETE' THEN 'warning' ELSE 'info' END
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  -- Nunca bloqueia a operação por falha de auditoria
  RAISE WARNING 'audit_trail falhou em %.%: %', TG_TABLE_NAME, TG_OP, SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- 6) Anexa triggers em todas as tabelas relevantes,
--    PULANDO tabelas de log/histórico/alto volume e a própria audit_trail.
DO $$
DECLARE
  r record;
  v_excluded text[] := ARRAY[
    'audit_trail',
    'fin_audit_log','fin_eventos_sistema','fin_sync_log','fin_agent_runs',
    'fin_gc_custo_history','fin_gc_price_history','fin_gc_price_review_log',
    'fin_produto_tributos_historico','fin_politica_markup_tabela_history',
    'fin_model_signals','fin_negociacao_jobs','fin_gc_write_jobs',
    'sync_log','auvo_expenses_sync',
    'fin_extrato_inter','fin_extrato_lancamentos',           -- alto volume sync bancário
    'gc_produtos_cache'                                       -- cache de produtos GC (já tem histórico próprio)
  ];
BEGIN
  FOR r IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND (
        table_name LIKE 'fin\_%' ESCAPE '\'
        OR table_name LIKE 'gc\_%' ESCAPE '\'
        OR table_name IN (
          'user_roles','profiles','configuracoes',
          'os_index','os_index_meta',
          'grupos_financeiros','grupos_pagamentos','grupo_itens','grupo_pagamento_itens',
          'pagamentos_programados'
        )
      )
      AND table_name <> ALL (v_excluded)
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_audit_%I ON public.%I;', r.table_name, r.table_name
    );
    EXECUTE format(
      'CREATE TRIGGER trg_audit_%I
         AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.fn_audit_trail_generic();',
      r.table_name, r.table_name
    );
  END LOOP;
END$$;
