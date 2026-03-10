
-- ================================================================
-- MÓDULO: FATURA CARTÃO — SCHEMA DELTA (tabelas já existem)
-- ================================================================

-- 1. fin_cartoes: adicionar colunas faltantes
ALTER TABLE public.fin_cartoes ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.fin_cartoes ADD COLUMN IF NOT EXISTS limite numeric(15,2);

-- 2. fin_fatura_cartao: adicionar observacao + unique
ALTER TABLE public.fin_fatura_cartao ADD COLUMN IF NOT EXISTS observacao text;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fin_fatura_cartao_cartao_mes_uq'
  ) THEN
    ALTER TABLE public.fin_fatura_cartao ADD CONSTRAINT fin_fatura_cartao_cartao_mes_uq UNIQUE (cartao_id, mes_referencia);
  END IF;
END $$;

-- 3. fin_fatura_transacoes: adicionar parcela + FK
ALTER TABLE public.fin_fatura_transacoes ADD COLUMN IF NOT EXISTS parcela_atual int NOT NULL DEFAULT 1;
ALTER TABLE public.fin_fatura_transacoes ADD COLUMN IF NOT EXISTS total_parcelas int NOT NULL DEFAULT 1;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fin_fatura_transacoes_lancamento_fk'
  ) THEN
    ALTER TABLE public.fin_fatura_transacoes
      ADD CONSTRAINT fin_fatura_transacoes_lancamento_fk
      FOREIGN KEY (lancamento_id) REFERENCES public.fin_pagamentos(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 4. Índices de performance
CREATE INDEX IF NOT EXISTS idx_fatura_cartao_cartao ON public.fin_fatura_cartao(cartao_id);
CREATE INDEX IF NOT EXISTS idx_fatura_cartao_mes ON public.fin_fatura_cartao(mes_referencia);
CREATE INDEX IF NOT EXISTS idx_fatura_trans_fatura ON public.fin_fatura_transacoes(fatura_id);
CREATE INDEX IF NOT EXISTS idx_fatura_trans_conc ON public.fin_fatura_transacoes(fatura_id, conciliado);
CREATE INDEX IF NOT EXISTS idx_fatura_trans_lanc ON public.fin_fatura_transacoes(lancamento_id);
CREATE INDEX IF NOT EXISTS idx_pagamentos_cartao ON public.fin_pagamentos(cartao_id) WHERE cartao_id IS NOT NULL;

-- 5. Triggers updated_at
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_fin_cartoes_updated_at') THEN
    CREATE TRIGGER set_fin_cartoes_updated_at
      BEFORE UPDATE ON public.fin_cartoes
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;

-- fin_fatura_cartao already has updated_at, ensure trigger
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_fin_fatura_cartao_updated_at') THEN
    CREATE TRIGGER set_fin_fatura_cartao_updated_at
      BEFORE UPDATE ON public.fin_fatura_cartao
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;

-- 6. RLS: add anon policies (project pattern uses both public+authenticated)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Anon rw' AND tablename = 'fin_cartoes') THEN
    CREATE POLICY "Anon rw" ON public.fin_cartoes FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Anon rw' AND tablename = 'fin_fatura_cartao') THEN
    CREATE POLICY "Anon rw" ON public.fin_fatura_cartao FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Anon rw' AND tablename = 'fin_fatura_transacoes') THEN
    CREATE POLICY "Anon rw" ON public.fin_fatura_transacoes FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 7. View auxiliar
CREATE OR REPLACE VIEW public.vw_fatura_pendente AS
SELECT
  ft.id, ft.fatura_id, fc.mes_referencia,
  c.nome AS cartao_nome, c.bandeira, c.ultimos_digitos,
  ft.data_transacao, ft.descricao, ft.valor,
  ft.categoria, ft.conciliado, ft.lancamento_id, ft.reconciliation_rule
FROM public.fin_fatura_transacoes ft
JOIN public.fin_fatura_cartao fc ON fc.id = ft.fatura_id
JOIN public.fin_cartoes c ON c.id = fc.cartao_id
WHERE ft.conciliado = false;
