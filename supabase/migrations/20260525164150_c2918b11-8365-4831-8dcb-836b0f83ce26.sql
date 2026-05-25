
-- Bug 1: trigger só pegava UPDATE. Agora pega INSERT também (seed + qualquer cache novo).
DROP TRIGGER IF EXISTS trg_repricing_on_cost_change ON public.gc_produtos_cache;

CREATE OR REPLACE FUNCTION public.fn_trigger_repricing_on_cost_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_token text;
  v_should_fire boolean := false;
BEGIN
  -- INSERT com custo > 0 OU UPDATE que mude custo
  IF TG_OP = 'INSERT' THEN
    v_should_fire := COALESCE(NEW.valor_custo, 0) > 0 AND COALESCE(NEW.ativo, true) = true;
  ELSIF TG_OP = 'UPDATE' THEN
    v_should_fire := (NEW.valor_custo IS DISTINCT FROM OLD.valor_custo)
                     AND COALESCE(NEW.valor_custo, 0) > 0
                     AND COALESCE(NEW.ativo, true) = true;
  END IF;

  IF NOT v_should_fire THEN
    RETURN NEW;
  END IF;

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
      'custo_anterior', CASE WHEN TG_OP='UPDATE' THEN OLD.valor_custo ELSE NULL END,
      'custo_novo',     NEW.valor_custo
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_trigger_repricing_on_cost_change failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_repricing_on_cost_change
AFTER INSERT OR UPDATE OF valor_custo ON public.gc_produtos_cache
FOR EACH ROW
EXECUTE FUNCTION public.fn_trigger_repricing_on_cost_change();
