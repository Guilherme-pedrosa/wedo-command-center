
CREATE TABLE public.fin_frete_rateios (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  frete_compra_gc_id TEXT NOT NULL UNIQUE,
  frete_compra_codigo TEXT NOT NULL,
  frete_valor_total NUMERIC(14,4) NOT NULL,
  frete_data DATE,
  refs_codigos TEXT[] NOT NULL DEFAULT '{}',
  refs_gc_ids TEXT[] NOT NULL DEFAULT '{}',
  refs_encontrados INTEGER NOT NULL DEFAULT 0,
  refs_faltantes TEXT[] NOT NULL DEFAULT '{}',
  pool_valor NUMERIC(14,4) NOT NULL DEFAULT 0,
  itens_impactados INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'aplicado',
  observacao TEXT,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.fin_frete_rateio_itens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rateio_id UUID NOT NULL REFERENCES public.fin_frete_rateios(id) ON DELETE CASCADE,
  compra_gc_id TEXT NOT NULL,
  compra_codigo TEXT,
  produto_gc_id TEXT,
  nome_produto TEXT,
  quantidade NUMERIC(14,4) NOT NULL DEFAULT 0,
  item_valor_total NUMERIC(14,4) NOT NULL DEFAULT 0,
  rateio_valor NUMERIC(14,4) NOT NULL DEFAULT 0,
  rateio_unit NUMERIC(14,6) NOT NULL DEFAULT 0,
  aplicado_em_tributos BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_frete_rateio_itens_rateio ON public.fin_frete_rateio_itens(rateio_id);
CREATE INDEX idx_frete_rateio_itens_compra ON public.fin_frete_rateio_itens(compra_gc_id);
CREATE INDEX idx_frete_rateio_itens_produto ON public.fin_frete_rateio_itens(produto_gc_id);

GRANT SELECT ON public.fin_frete_rateios TO authenticated;
GRANT ALL ON public.fin_frete_rateios TO service_role;
GRANT SELECT ON public.fin_frete_rateio_itens TO authenticated;
GRANT ALL ON public.fin_frete_rateio_itens TO service_role;

ALTER TABLE public.fin_frete_rateios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_frete_rateio_itens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Autenticados podem ler rateios de frete"
  ON public.fin_frete_rateios FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role gerencia rateios de frete"
  ON public.fin_frete_rateios FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Autenticados podem ler itens de rateio de frete"
  ON public.fin_frete_rateio_itens FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role gerencia itens de rateio de frete"
  ON public.fin_frete_rateio_itens FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER trg_fin_frete_rateios_updated
  BEFORE UPDATE ON public.fin_frete_rateios
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
