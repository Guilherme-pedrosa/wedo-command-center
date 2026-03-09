
ALTER TABLE public.fin_metas_tecnicos DROP CONSTRAINT IF EXISTS fin_metas_tecnicos_nome_tecnico_key;

CREATE POLICY "Allow all operations fin_metas_tecnicos" ON public.fin_metas_tecnicos
  FOR ALL USING (true) WITH CHECK (true);
