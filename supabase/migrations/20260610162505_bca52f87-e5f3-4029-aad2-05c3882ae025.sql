
ALTER TABLE public.auvo_expenses_sync
  ALTER COLUMN type_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS fatura_transacao_id uuid REFERENCES public.fin_fatura_transacoes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS conciliado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS conciliado_em timestamptz,
  ADD COLUMN IF NOT EXISTS match_method text;

CREATE INDEX IF NOT EXISTS idx_auvo_exp_fatura_trans ON public.auvo_expenses_sync(fatura_transacao_id);
CREATE INDEX IF NOT EXISTS idx_auvo_exp_concil ON public.auvo_expenses_sync(conciliado, expense_date);
CREATE INDEX IF NOT EXISTS idx_auvo_exp_amount ON public.auvo_expenses_sync(amount, expense_date);
