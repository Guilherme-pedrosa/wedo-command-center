-- Grant access to the table
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fin_gc_write_jobs TO authenticated;
GRANT ALL ON public.fin_gc_write_jobs TO service_role;

-- Ensure RLS is enabled
ALTER TABLE public.fin_gc_write_jobs ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to recreate them cleanly
DROP POLICY IF EXISTS "precif_jobs_insert" ON public.fin_gc_write_jobs;
DROP POLICY IF EXISTS "precif_jobs_select" ON public.fin_gc_write_jobs;
DROP POLICY IF EXISTS "precif_jobs_update" ON public.fin_gc_write_jobs;
DROP POLICY IF EXISTS "precif_jobs_delete" ON public.fin_gc_write_jobs;

-- Create policies
CREATE POLICY "Allow authenticated insert"
ON public.fin_gc_write_jobs
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Allow authenticated select"
ON public.fin_gc_write_jobs
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Allow authenticated update"
ON public.fin_gc_write_jobs
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow authenticated delete"
ON public.fin_gc_write_jobs
FOR DELETE
TO authenticated
USING (true);
