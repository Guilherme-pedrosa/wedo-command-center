ALTER TABLE public.fin_produto_tributos
  ADD COLUMN IF NOT EXISTS descricao_nf text,
  ADD COLUMN IF NOT EXISTS unidade_comercial_nf text,
  ADD COLUMN IF NOT EXISTS unidade_tributavel_nf text;

COMMENT ON COLUMN public.fin_produto_tributos.descricao_nf IS 'Descrição original xProd do item na NF-e; não usar medidas no texto como conversão de quantidade.';
COMMENT ON COLUMN public.fin_produto_tributos.unidade_comercial_nf IS 'Unidade comercial uCom original do item na NF-e.';
COMMENT ON COLUMN public.fin_produto_tributos.unidade_tributavel_nf IS 'Unidade tributável uTrib original do item na NF-e.';