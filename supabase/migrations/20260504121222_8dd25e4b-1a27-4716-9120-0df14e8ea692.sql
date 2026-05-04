CREATE TABLE IF NOT EXISTS public.fin_negociacao_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pendente', -- pendente | processando | concluido | erro
  payload jsonb NOT NULL,
  resultado jsonb,
  progresso text,
  ok_count integer DEFAULT 0,
  erro_count integer DEFAULT 0,
  total_count integer DEFAULT 0,
  erro_msg text,
  tentativas integer DEFAULT 0,
  iniciado_em timestamptz,
  finalizado_em timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fin_negociacao_jobs_status_created
  ON public.fin_negociacao_jobs(status, created_at);

ALTER TABLE public.fin_negociacao_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon access" ON public.fin_negociacao_jobs
  FOR ALL TO public USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated access" ON public.fin_negociacao_jobs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TRIGGER trg_fin_negociacao_jobs_updated_at
  BEFORE UPDATE ON public.fin_negociacao_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();