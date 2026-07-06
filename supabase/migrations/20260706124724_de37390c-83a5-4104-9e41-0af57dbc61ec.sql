SELECT cron.schedule(
  'sync-gc-produtos-daily-6am-brt',
  '0 9 * * *',
  $$
  SELECT net.http_post(
    url := 'https://mgiebypxhnmpktljrzjq.supabase.co/functions/v1/sync-gc-produtos',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1naWVieXB4aG5tcGt0bGpyempxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5MTA3MzgsImV4cCI6MjA4ODQ4NjczOH0.BXmHfK6frT0KO0uAvky2romxNkJjm4mj-lS8ExGFkrY"}'::jsonb,
    body := concat('{"time":"', now(), '","source":"cron"}')::jsonb,
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);