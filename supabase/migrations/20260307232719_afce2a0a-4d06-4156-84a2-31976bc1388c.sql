
CREATE TABLE IF NOT EXISTS public.fin_metas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('receita','despesa','lucro','margem')),
  periodo_tipo TEXT NOT NULL CHECK (periodo_tipo IN ('mensal','trimestral','anual')),
  periodo_ano INTEGER NOT NULL,
  periodo_mes INTEGER CHECK (periodo_mes BETWEEN 1 AND 12),
  periodo_trimestre INTEGER CHECK (periodo_trimestre BETWEEN 1 AND 4),
  plano_contas_id UUID REFERENCES public.fin_plano_contas(id),
  centro_custo_id UUID REFERENCES public.fin_centros_custo(id),
  valor_meta NUMERIC(15,2) NOT NULL,
  alerta_pct NUMERIC(5,2) DEFAULT 80.0,
  ativo BOOLEAN DEFAULT TRUE,
  observacao TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(plano_contas_id, centro_custo_id, periodo_tipo, periodo_ano, periodo_mes, periodo_trimestre, tipo)
);

ALTER TABLE public.fin_metas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon access" ON public.fin_metas FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated access" ON public.fin_metas FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE INDEX idx_fin_metas_periodo ON public.fin_metas(periodo_ano, periodo_mes);
CREATE INDEX idx_fin_metas_pc ON public.fin_metas(plano_contas_id);
CREATE INDEX idx_fin_metas_cc ON public.fin_metas(centro_custo_id);
