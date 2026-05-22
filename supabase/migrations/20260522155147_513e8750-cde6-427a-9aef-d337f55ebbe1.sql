-- FASE C: gc_produtos_cache + GENERATED column + pg_cron
-- =====================================================

-- Tabela cache de produtos do GestãoClick
CREATE TABLE IF NOT EXISTS public.gc_produtos_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gc_id text NOT NULL UNIQUE,
  codigo text,
  nome text NOT NULL,
  descricao text,
  unidade text,
  ncm text,
  cfop text,
  preco_venda numeric(14,4),
  preco_custo numeric(14,4),
  estoque numeric(14,4),
  marca text,
  categoria text,
  ativo boolean NOT NULL DEFAULT true,
  -- GENERATED: markup atual = (preco_venda - preco_custo) / preco_custo
  markup_atual numeric(10,6) GENERATED ALWAYS AS (
    CASE
      WHEN preco_custo IS NULL OR preco_custo = 0 THEN NULL
      WHEN preco_venda IS NULL THEN NULL
      ELSE ROUND(((preco_venda - preco_custo) / preco_custo)::numeric, 6)
    END
  ) STORED,
  payload_raw jsonb,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gc_produtos_cache_codigo ON public.gc_produtos_cache(codigo);
CREATE INDEX IF NOT EXISTS idx_gc_produtos_cache_nome ON public.gc_produtos_cache USING gin (to_tsvector('portuguese', coalesce(nome,'')));
CREATE INDEX IF NOT EXISTS idx_gc_produtos_cache_marca ON public.gc_produtos_cache(marca);
CREATE INDEX IF NOT EXISTS idx_gc_produtos_cache_ativo ON public.gc_produtos_cache(ativo);

-- RLS
ALTER TABLE public.gc_produtos_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gc_produtos_cache select roles"
  ON public.gc_produtos_cache FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'gerente_comercial'::app_role)
    OR public.has_role(auth.uid(), 'gerente_financeiro'::app_role)
  );

CREATE POLICY "gc_produtos_cache service write"
  ON public.gc_produtos_cache FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- updated_at trigger
CREATE TRIGGER trg_gc_produtos_cache_updated_at
  BEFORE UPDATE ON public.gc_produtos_cache
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- pg_cron: sincroniza produtos a cada 60min
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove cron antigo se existir
DO $$ BEGIN
  PERFORM cron.unschedule('sync-gc-produtos-60min');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'sync-gc-produtos-60min',
  '*/60 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://mgiebypxhnmpktljrzjq.supabase.co/functions/v1/sync-gc-produtos',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1naWVieXB4aG5tcGt0bGpyempxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5MTA3MzgsImV4cCI6MjA4ODQ4NjczOH0.BXmHfK6frT0KO0uAvky2romxNkJjm4mj-lS8ExGFkrY'
    ),
    body := jsonb_build_object('source','cron')
  );
  $$
);