
ALTER TABLE public.fin_fatura_cartao
  ADD COLUMN IF NOT EXISTS forma_pagamento_id uuid REFERENCES public.fin_formas_pagamento(id),
  ADD COLUMN IF NOT EXISTS extrato_liquidante_id uuid REFERENCES public.fin_extrato_inter(id),
  ADD COLUMN IF NOT EXISTS data_fechamento_inicio date,
  ADD COLUMN IF NOT EXISTS data_fechamento_fim date;

COMMENT ON COLUMN public.fin_fatura_cartao.forma_pagamento_id IS 'Forma de pagamento usada para filtrar pagamentos da fatura';
COMMENT ON COLUMN public.fin_fatura_cartao.extrato_liquidante_id IS 'Transação do extrato bancário que quitou esta fatura';
COMMENT ON COLUMN public.fin_fatura_cartao.data_fechamento_inicio IS 'Início do período de fechamento (data de corte anterior)';
COMMENT ON COLUMN public.fin_fatura_cartao.data_fechamento_fim IS 'Fim do período de fechamento (data de corte atual)';
