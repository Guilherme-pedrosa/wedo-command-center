ALTER TABLE public.fin_residuos_negociacao
  ADD COLUMN IF NOT EXISTS gc_recebimento_id text,
  ADD COLUMN IF NOT EXISTS gc_codigo text,
  ADD COLUMN IF NOT EXISTS os_codigos text[];