
ALTER TABLE public.os_index
  ADD COLUMN IF NOT EXISTS data_execucao_real date,
  ADD COLUMN IF NOT EXISTS data_execucao_origem text,
  ADD COLUMN IF NOT EXISTS auvo_task_id text,
  ADD COLUMN IF NOT EXISTS data_execucao_sincronizada_em timestamptz;

CREATE INDEX IF NOT EXISTS idx_os_index_data_execucao_real
  ON public.os_index(data_execucao_real);

CREATE INDEX IF NOT EXISTS idx_os_index_auvo_task_id
  ON public.os_index(auvo_task_id) WHERE auvo_task_id IS NOT NULL;
