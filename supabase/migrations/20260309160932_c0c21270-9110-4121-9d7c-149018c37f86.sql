
DROP INDEX IF EXISTS public.fin_plano_contas_gc_id_unique;
CREATE UNIQUE INDEX fin_plano_contas_gc_id_unique ON public.fin_plano_contas (gc_id);
