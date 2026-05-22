DO $$ BEGIN
  PERFORM cron.unschedule('sync-gc-produtos-60min');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DROP TABLE IF EXISTS public.gc_produtos_cache CASCADE;