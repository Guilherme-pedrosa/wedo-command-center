ALTER TABLE public.os_index
  ADD COLUMN IF NOT EXISTS execucao_verificacao_status text,
  ADD COLUMN IF NOT EXISTS execucao_verificacao_motivo text,
  ADD COLUMN IF NOT EXISTS execucao_verificado_em timestamptz,
  ADD COLUMN IF NOT EXISTS auvo_task_ids text[],
  ADD COLUMN IF NOT EXISTS data_execucao_anterior date,
  ADD COLUMN IF NOT EXISTS data_execucao_estimada date;

CREATE INDEX IF NOT EXISTS idx_os_index_exec_verif ON public.os_index (execucao_verificacao_status, execucao_verificado_em);

CREATE TABLE IF NOT EXISTS public.fin_os_execucao_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id uuid NOT NULL,
  os_id text NOT NULL,
  os_codigo text,
  auvo_task_ids text[],
  status text NOT NULL,
  motivo text,
  data_execucao_antes date,
  data_execucao_depois date,
  origem_antes text,
  origem_depois text,
  dry_run boolean NOT NULL DEFAULT false,
  evidencia jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.fin_os_execucao_log TO authenticated;
GRANT ALL ON public.fin_os_execucao_log TO service_role;
ALTER TABLE public.fin_os_execucao_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fin_os_execucao_log_select" ON public.fin_os_execucao_log FOR SELECT TO authenticated USING (true);
CREATE INDEX IF NOT EXISTS idx_fin_os_execucao_log_run ON public.fin_os_execucao_log (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fin_os_execucao_log_os ON public.fin_os_execucao_log (os_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.fin_job_locks (
  nome text NOT NULL PRIMARY KEY,
  run_id uuid,
  status text NOT NULL DEFAULT 'running',
  locked_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  cursor_value text,
  payload jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.fin_job_locks TO authenticated;
GRANT ALL ON public.fin_job_locks TO service_role;
ALTER TABLE public.fin_job_locks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fin_job_locks_select" ON public.fin_job_locks FOR SELECT TO authenticated USING (true);
CREATE TRIGGER trg_fin_job_locks_updated_at BEFORE UPDATE ON public.fin_job_locks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.fin_premiacao_cache (
  mes text NOT NULL PRIMARY KEY,
  comissao_final numeric NOT NULL,
  comissao_total numeric,
  faturamento_premiacao numeric,
  origem text NOT NULL DEFAULT 'premiacao',
  versao integer NOT NULL DEFAULT 1,
  calculado_em timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.fin_premiacao_cache TO authenticated;
GRANT ALL ON public.fin_premiacao_cache TO service_role;
ALTER TABLE public.fin_premiacao_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fin_premiacao_cache_select" ON public.fin_premiacao_cache FOR SELECT TO authenticated USING (true);
CREATE TRIGGER trg_fin_premiacao_cache_updated_at BEFORE UPDATE ON public.fin_premiacao_cache
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.fin_metas ADD COLUMN IF NOT EXISTS fonte text;