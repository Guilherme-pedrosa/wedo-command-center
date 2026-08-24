-- Simples Nacional não implica vedação automática aos créditos não cumulativos
-- de PIS/COFINS do adquirente. Neste projeto, o enquadramento do fornecedor no
-- Simples bloqueia apenas o crédito de ICMS; vedações específicas de produto ou
-- operação continuam sendo tratadas pelos overrides fiscais.

COMMENT ON COLUMN public.fin_produto_tributos.sem_credito IS
  'Vedação integral excepcional de créditos de entrada; não usar automaticamente para fornecedor do Simples Nacional.';

UPDATE public.fin_produto_tributos
SET
  sem_credito = false,
  icms_aliquota = 0,
  icms_base = 0,
  valor_icms_unit = 0,
  pis_aliquota = CASE
    WHEN pis_aliquota_manual IS NULL THEN 1.65
    ELSE pis_aliquota
  END,
  cofins_aliquota = CASE
    WHEN cofins_aliquota_manual IS NULL THEN 7.60
    ELSE cofins_aliquota
  END,
  valor_pis_unit = ROUND(
    COALESCE(valor_unitario_nf, 0) * COALESCE(pis_aliquota_manual, 1.65) / 100,
    2
  ),
  valor_cofins_unit = ROUND(
    COALESCE(valor_unitario_nf, 0) * COALESCE(cofins_aliquota_manual, 7.60) / 100,
    2
  ),
  custo_efetivo_unit = ROUND(
    COALESCE(valor_unitario_nf, 0)
      + COALESCE(valor_ipi_unit, 0)
      + COALESCE(valor_frete_unit, 0)
      - (COALESCE(valor_unitario_nf, 0) * COALESCE(pis_aliquota_manual, 1.65) / 100)
      - (COALESCE(valor_unitario_nf, 0) * COALESCE(cofins_aliquota_manual, 7.60) / 100),
    2
  ),
  ultima_atualizacao = now()
WHERE regime_fornecedor = 'simples_nacional';
