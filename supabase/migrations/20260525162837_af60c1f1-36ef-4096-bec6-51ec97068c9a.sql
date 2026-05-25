
-- 1. Refator da trigger: usa vault em vez de JWT hardcoded
CREATE OR REPLACE FUNCTION public.fn_trigger_repricing_on_cost_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_token text;
BEGIN
  IF (NEW.valor_custo IS DISTINCT FROM OLD.valor_custo)
     AND NEW.valor_custo IS NOT NULL
     AND NEW.valor_custo > 0
     AND COALESCE(NEW.ativo, true) = true
  THEN
    SELECT decrypted_secret INTO v_token
    FROM vault.decrypted_secrets
    WHERE name = 'edge_function_invoke_token'
    LIMIT 1;

    IF v_token IS NULL THEN
      RAISE WARNING 'fn_trigger_repricing_on_cost_change: token não configurado no vault';
      RETURN NEW;
    END IF;

    PERFORM extensions.http_post(
      url := 'https://mgiebypxhnmpktljrzjq.supabase.co/functions/v1/repricing-on-cost-change',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_token
      ),
      body := jsonb_build_object(
        'gc_produto_id', NEW.produto_gc_id,
        'nome_produto',  NEW.nome,
        'custo_anterior', OLD.valor_custo,
        'custo_novo',     NEW.valor_custo
      )
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_trigger_repricing_on_cost_change failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- 2. Colunas do worker em fin_gc_write_jobs (idempotente)
ALTER TABLE public.fin_gc_write_jobs 
  ADD COLUMN IF NOT EXISTS processado_em timestamptz,
  ADD COLUMN IF NOT EXISTS response_body jsonb;

-- (tentativas, ultimo_erro, finalizado_em já existem conforme schema)

-- 3. Constraint de status aceitos
ALTER TABLE public.fin_gc_write_jobs 
  DROP CONSTRAINT IF EXISTS fin_gc_write_jobs_status_check;

ALTER TABLE public.fin_gc_write_jobs
  ADD CONSTRAINT fin_gc_write_jobs_status_check 
  CHECK (status IN ('pendente', 'processando', 'sucesso', 'erro_retentavel', 'erro_fatal'));

-- 4. Índice para fila eficiente
CREATE INDEX IF NOT EXISTS idx_gc_write_jobs_fila 
  ON public.fin_gc_write_jobs(status, created_at) 
  WHERE status IN ('pendente', 'erro_retentavel');

-- 5. Cron a cada 2 minutos - busca token do vault dinamicamente
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

-- Remove agendamento anterior se existir
SELECT cron.unschedule('process-gc-write-jobs-every-2min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-gc-write-jobs-every-2min');

SELECT cron.schedule(
  'process-gc-write-jobs-every-2min',
  '*/2 * * * *',
  $cron$
  SELECT extensions.http_post(
    url := 'https://mgiebypxhnmpktljrzjq.supabase.co/functions/v1/process-gc-write-jobs',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets 
        WHERE name = 'edge_function_invoke_token' LIMIT 1
      )
    ),
    body := jsonb_build_object('source', 'cron')
  );
  $cron$
);
