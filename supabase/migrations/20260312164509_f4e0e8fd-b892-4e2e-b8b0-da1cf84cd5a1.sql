ALTER TABLE public.fin_produto_tributos 
  ADD COLUMN IF NOT EXISTS cfop text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS nf_chave text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS compra_gc_id text DEFAULT NULL;
