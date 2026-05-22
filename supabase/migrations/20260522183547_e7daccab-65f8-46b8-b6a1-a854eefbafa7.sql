-- 1.1 produto_gc_id aceita NULL
DO $$ 
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'gc_compras_itens' 
      AND column_name = 'produto_gc_id' 
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE gc_compras_itens ALTER COLUMN produto_gc_id DROP NOT NULL;
  END IF;
END $$;

-- 1.2 origem_vinculo
ALTER TABLE gc_compras_itens 
  ADD COLUMN IF NOT EXISTS origem_vinculo TEXT 
    CHECK (origem_vinculo IN ('produto_id_gc', 'legacy_sem_produto_id', 'manual'));

-- 1.3 Backfill
UPDATE gc_compras_itens 
SET origem_vinculo = 'produto_id_gc' 
WHERE produto_gc_id IS NOT NULL AND origem_vinculo IS NULL;

-- 1.4 Índice legacy
CREATE INDEX IF NOT EXISTS idx_gc_compras_itens_legacy_nome 
  ON gc_compras_itens (compra_gc_id, nome_produto, valor_custo) 
  WHERE produto_gc_id IS NULL;

-- 1.5 re_enrichment_needed
ALTER TABLE gc_compras 
  ADD COLUMN IF NOT EXISTS re_enrichment_needed BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_gc_compras_re_enrichment 
  ON gc_compras (re_enrichment_needed) WHERE re_enrichment_needed = true;