ALTER TABLE public.fin_produto_tributos
  ADD COLUMN IF NOT EXISTS fator_embalagem numeric(14,4) DEFAULT 1;

COMMENT ON COLUMN public.fin_produto_tributos.fator_embalagem IS
  'Fator de conversao embalagem NF -> unidade de venda. Ex.: NF traz 1 pacote, pedido tem 100 un => fator=100. valor_unitario_nf ja vem dividido por esse fator.';