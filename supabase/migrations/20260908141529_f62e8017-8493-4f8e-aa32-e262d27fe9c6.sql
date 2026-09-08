SELECT cron.schedule(
  'premiacao-cache-backfill-hourly',
  '50 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://mgiebypxhnmpktljrzjq.supabase.co/functions/v1/premiacao-comissoes-total',
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'edge_function_invoke_token')),
    body := jsonb_build_object('backfill_ano', extract(year from (now() AT TIME ZONE 'America/Sao_Paulo'))::int),
    timeout_milliseconds := 200000
  );
  $$
);