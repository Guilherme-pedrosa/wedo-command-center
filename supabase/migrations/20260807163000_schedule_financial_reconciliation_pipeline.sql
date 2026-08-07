CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- O importador isolado concorria com o sync-all nos mesmos minutos.
DO $$
BEGIN
  PERFORM cron.unschedule('inter-extrato-custom-brt');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('financial-reconciliation-every-30min');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Executa entre as janelas do sync-all. A própria função possui trava de
-- deduplicação para chamadas manuais ou disparadas pelo sync-all.
SELECT cron.schedule(
  'financial-reconciliation-every-30min',
  '15,45 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mgiebypxhnmpktljrzjq.supabase.co/functions/v1/financial-reconciliation-pipeline',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('source', 'cron'),
    timeout_milliseconds := 10000
  ) AS request_id;
  $cron$
);
