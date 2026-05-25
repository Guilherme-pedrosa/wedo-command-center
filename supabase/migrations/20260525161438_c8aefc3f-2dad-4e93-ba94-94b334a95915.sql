
-- Trigger: when gc_produtos_cache.valor_custo changes, fire edge function to re-evaluate all price tables
CREATE OR REPLACE FUNCTION public.fn_trigger_repricing_on_cost_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  IF (NEW.valor_custo IS DISTINCT FROM OLD.valor_custo)
     AND NEW.valor_custo IS NOT NULL
     AND NEW.valor_custo > 0
     AND COALESCE(NEW.ativo, true) = true
  THEN
    PERFORM extensions.http_post(
      url := 'https://mgiebypxhnmpktljrzjq.supabase.co/functions/v1/repricing-on-cost-change',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1naWVieXB4aG5tcGt0bGpyempxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5MTA3MzgsImV4cCI6MjA4ODQ4NjczOH0.BXmHfK6frT0KO0uAvky2romxNkJjm4mj-lS8ExGFkrY'
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

DROP TRIGGER IF EXISTS trg_repricing_on_cost_change ON public.gc_produtos_cache;
CREATE TRIGGER trg_repricing_on_cost_change
AFTER UPDATE OF valor_custo ON public.gc_produtos_cache
FOR EACH ROW
EXECUTE FUNCTION public.fn_trigger_repricing_on_cost_change();
