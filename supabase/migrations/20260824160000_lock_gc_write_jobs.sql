-- O navegador pode solicitar e consultar jobs, mas somente a Edge Function
-- (service_role, que ignora RLS) pode declarar sucesso e gravar a prova do GC.
DROP POLICY IF EXISTS "Allow authenticated insert" ON public.fin_gc_write_jobs;
DROP POLICY IF EXISTS "Allow authenticated select" ON public.fin_gc_write_jobs;
DROP POLICY IF EXISTS "Allow authenticated update" ON public.fin_gc_write_jobs;
DROP POLICY IF EXISTS "Allow authenticated delete" ON public.fin_gc_write_jobs;
DROP POLICY IF EXISTS "precif_jobs_insert" ON public.fin_gc_write_jobs;
DROP POLICY IF EXISTS "precif_jobs_select" ON public.fin_gc_write_jobs;
DROP POLICY IF EXISTS "precif_jobs_update" ON public.fin_gc_write_jobs;
DROP POLICY IF EXISTS "precif_jobs_delete" ON public.fin_gc_write_jobs;

CREATE POLICY "gc_jobs_finance_insert"
ON public.fin_gc_write_jobs
FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'admin')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'gerente_financeiro')
);

CREATE POLICY "gc_jobs_finance_select"
ON public.fin_gc_write_jobs
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'gerente_financeiro')
);

REVOKE UPDATE, DELETE ON public.fin_gc_write_jobs FROM authenticated;
GRANT SELECT, INSERT ON public.fin_gc_write_jobs TO authenticated;
GRANT ALL ON public.fin_gc_write_jobs TO service_role;
