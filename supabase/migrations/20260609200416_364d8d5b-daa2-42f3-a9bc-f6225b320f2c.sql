UPDATE public.os_index
SET data_execucao_real = NULL,
    data_execucao_origem = NULL,
    auvo_task_id = NULL,
    data_execucao_sincronizada_em = NULL
WHERE data_execucao_real IS NOT NULL
   OR data_execucao_origem IS NOT NULL
   OR auvo_task_id IS NOT NULL
   OR data_execucao_sincronizada_em IS NOT NULL;