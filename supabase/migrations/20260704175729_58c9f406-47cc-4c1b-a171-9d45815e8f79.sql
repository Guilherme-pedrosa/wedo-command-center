ALTER TABLE public.gc_compras_itens
ADD COLUMN IF NOT EXISTS item_gc_id text;

CREATE INDEX IF NOT EXISTS idx_gc_compras_itens_item_gc_id
ON public.gc_compras_itens(item_gc_id);