
-- Funções de normalização (IMMUTABLE)
CREATE OR REPLACE FUNCTION public.normalizar_numero_nf(n TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(n, ''), '[^0-9]', '', 'g'), '^0+', '')
$$;

CREATE OR REPLACE FUNCTION public.normalizar_cnpj(c TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT REGEXP_REPLACE(COALESCE(c, ''), '[^0-9]', '', 'g')
$$;

-- ALTER gc_compras: adicionar colunas para matching determinístico
ALTER TABLE public.gc_compras
  ADD COLUMN IF NOT EXISTS numero_nfe TEXT,
  ADD COLUMN IF NOT EXISTS cnpj_fornecedor TEXT,
  ADD COLUMN IF NOT EXISTS modificado_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_gc_compras_numero_nfe_norm
  ON public.gc_compras (public.normalizar_numero_nf(numero_nfe))
  WHERE numero_nfe IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gc_compras_cnpj_norm
  ON public.gc_compras (public.normalizar_cnpj(cnpj_fornecedor))
  WHERE cnpj_fornecedor IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gc_compras_gc_id_text ON public.gc_compras (gc_id);

-- Tabela gc_compras_itens
CREATE TABLE IF NOT EXISTS public.gc_compras_itens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_gc_id    TEXT NOT NULL,
  produto_gc_id   TEXT NOT NULL,
  nome_produto    TEXT,
  unidade         TEXT,
  quantidade      NUMERIC(14,4),
  valor_custo     NUMERIC(14,4),
  valor_total     NUMERIC(14,4),
  ordem_item      INT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gc_compras_itens_compra ON public.gc_compras_itens(compra_gc_id);
CREATE INDEX IF NOT EXISTS idx_gc_compras_itens_produto ON public.gc_compras_itens(produto_gc_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gc_compras_itens_compra_ordem
  ON public.gc_compras_itens(compra_gc_id, ordem_item);

ALTER TABLE public.gc_compras_itens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anon access" ON public.gc_compras_itens;
DROP POLICY IF EXISTS "Authenticated access" ON public.gc_compras_itens;

CREATE POLICY "Anon access" ON public.gc_compras_itens FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated access" ON public.gc_compras_itens FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Seed checkpoint config
INSERT INTO public.fin_configuracoes(chave, valor, descricao) VALUES
  ('LAST_SYNC_COMPRAS_ENRICHMENT_CURSOR', '0', 'gc_id da última compra processada no enrichment. 0 = início.'),
  ('LAST_SYNC_COMPRAS_ENRICHMENT_COMPLETED_AT', '', 'Timestamp ISO do último enrichment completo'),
  ('SYNC_COMPRAS_ENRICHMENT_TIMEOUT_SEGUNDOS', '25', 'Tempo máx por chamada antes de retornar 202'),
  ('SYNC_COMPRAS_ENRICHMENT_BATCH_SIZE', '1', 'Quantas compras processadas por iteração do enrichment (1 = GET individual)')
ON CONFLICT (chave) DO NOTHING;
