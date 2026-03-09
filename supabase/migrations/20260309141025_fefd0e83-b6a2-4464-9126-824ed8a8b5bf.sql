
-- Add unique constraint on gc_id for fin_plano_contas (for upsert from GC sync)
CREATE UNIQUE INDEX IF NOT EXISTS fin_plano_contas_gc_id_unique ON public.fin_plano_contas (gc_id) WHERE gc_id IS NOT NULL;

-- Add unique constraint on codigo for fin_centros_custo (for upsert from GC sync)  
CREATE UNIQUE INDEX IF NOT EXISTS fin_centros_custo_codigo_unique ON public.fin_centros_custo (codigo) WHERE codigo IS NOT NULL;
