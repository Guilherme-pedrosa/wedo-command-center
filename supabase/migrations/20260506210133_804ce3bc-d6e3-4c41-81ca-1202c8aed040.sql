DELETE FROM public.fin_meta_plano_contas a
USING public.fin_meta_plano_contas b
WHERE a.ctid > b.ctid
  AND a.meta_id = b.meta_id
  AND a.plano_contas_id = b.plano_contas_id
  AND COALESCE(a.centro_custo_id::text, '') = COALESCE(b.centro_custo_id::text, '');

CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_meta_plano_contas_unique
  ON public.fin_meta_plano_contas (meta_id, plano_contas_id, (COALESCE(centro_custo_id::text, '')));