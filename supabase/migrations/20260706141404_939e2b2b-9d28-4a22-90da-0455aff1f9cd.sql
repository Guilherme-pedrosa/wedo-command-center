ALTER TABLE public.fin_produto_tributos
  ADD COLUMN IF NOT EXISTS ineligivel_precificacao boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ineligivel_motivo text;

CREATE INDEX IF NOT EXISTS idx_fpt_ineligivel
  ON public.fin_produto_tributos(ineligivel_precificacao)
  WHERE ineligivel_precificacao = true;