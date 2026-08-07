-- A baixa era disparada por três caminhos concorrentes: trigger pg_net,
-- reconciliation-engine e varredura final. Isso causava milhares de PUTs
-- repetidos no GestãoClick e respostas 403/429.
DROP TRIGGER IF EXISTS trg_argus_baixa_confirmada
  ON public.fin_extrato_lancamentos;

DROP FUNCTION IF EXISTS public.fn_trigger_argus_baixa_confirmada();

-- A fila única parte dos vínculos conciliados e consulta estes estados.
CREATE INDEX IF NOT EXISTS idx_fin_recebimentos_argus_baixa_pending
  ON public.fin_recebimentos (id)
  WHERE pago_sistema IS TRUE AND gc_baixado IS NOT TRUE;

CREATE INDEX IF NOT EXISTS idx_fin_pagamentos_argus_baixa_pending
  ON public.fin_pagamentos (id)
  WHERE pago_sistema IS TRUE AND gc_baixado IS NOT TRUE;

CREATE INDEX IF NOT EXISTS idx_fin_sync_log_argus_running
  ON public.fin_sync_log (created_at DESC)
  WHERE tipo = 'argus_baixa_job' AND status = 'running';
