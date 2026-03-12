ALTER TABLE public.fin_produto_tributos 
  ADD COLUMN IF NOT EXISTS regime_fornecedor text DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS icms_aliquota_manual numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pis_aliquota_manual numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cofins_aliquota_manual numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ipi_aliquota_manual numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sem_credito boolean DEFAULT false;

COMMENT ON COLUMN public.fin_produto_tributos.regime_fornecedor IS 'normal, simples_nacional';
COMMENT ON COLUMN public.fin_produto_tributos.sem_credito IS 'Se true, zera todos os créditos de entrada (Simples Nacional)';