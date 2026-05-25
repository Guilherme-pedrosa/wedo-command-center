ALTER TABLE public.fin_produto_tributos ADD COLUMN IF NOT EXISTS compra_codigo text;
CREATE INDEX IF NOT EXISTS idx_fin_produto_tributos_compra_codigo ON public.fin_produto_tributos(compra_codigo);
-- Limpa matches por valor (inferência sem confirmação por código/nome) para forçar resync
DELETE FROM public.fin_produto_tributos
WHERE match_rule IN ('valor_total','valor_unit_qtd')
  AND icms_aliquota_manual IS NULL
  AND pis_aliquota_manual IS NULL
  AND cofins_aliquota_manual IS NULL
  AND ipi_aliquota_manual IS NULL
  AND COALESCE(sem_credito,false) = false;