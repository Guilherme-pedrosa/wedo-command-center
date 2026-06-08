ALTER TABLE public.fin_produto_tributos
  ADD COLUMN IF NOT EXISTS excecao_manual boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS excecao_motivo text,
  ADD COLUMN IF NOT EXISTS excecao_at timestamptz,
  ADD COLUMN IF NOT EXISTS excecao_by uuid REFERENCES auth.users(id);

COMMENT ON COLUMN public.fin_produto_tributos.excecao_manual IS 'Quando true, silencia alertas de divergência NF×GC (pedido corrigido manualmente no ERP, financeiro já pago)';