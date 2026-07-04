
CREATE TABLE public.fin_nfe_picker_descartes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  compra_gc_id TEXT NOT NULL,
  compra_codigo TEXT,
  produto_gc_id TEXT,
  nome_produto_pedido TEXT,
  codigo_interno_pedido TEXT,
  quantidade_pedido NUMERIC(14,4),
  valor_unit_pedido NUMERIC(14,4),
  valor_total_pedido NUMERIC(14,4),
  nf_chave TEXT,
  nf_numero TEXT,
  motivo TEXT NOT NULL,
  candidatos JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_picker_descartes_compra ON public.fin_nfe_picker_descartes(compra_gc_id);
CREATE INDEX idx_picker_descartes_produto ON public.fin_nfe_picker_descartes(produto_gc_id);
CREATE INDEX idx_picker_descartes_created ON public.fin_nfe_picker_descartes(created_at DESC);

GRANT SELECT ON public.fin_nfe_picker_descartes TO authenticated;
GRANT ALL ON public.fin_nfe_picker_descartes TO service_role;

ALTER TABLE public.fin_nfe_picker_descartes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Autenticados leem descartes do picker"
  ON public.fin_nfe_picker_descartes FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role gerencia descartes do picker"
  ON public.fin_nfe_picker_descartes FOR ALL TO service_role USING (true) WITH CHECK (true);
