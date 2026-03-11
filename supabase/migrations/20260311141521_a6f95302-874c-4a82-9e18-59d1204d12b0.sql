ALTER TABLE public.fin_grupos_receber
  ADD COLUMN nfse_numero text,
  ADD COLUMN nfse_link text,
  ADD COLUMN nfse_emitida_em timestamp with time zone,
  ADD COLUMN nfse_status text DEFAULT 'pendente';