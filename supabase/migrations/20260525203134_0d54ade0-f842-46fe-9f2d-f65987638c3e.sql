-- 1. Policies de INSERT em fin_eventos_sistema
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='fin_eventos_sistema' AND policyname='service_role_insert_eventos') THEN
    CREATE POLICY service_role_insert_eventos ON public.fin_eventos_sistema FOR INSERT TO service_role WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='fin_eventos_sistema' AND policyname='definer_insert_eventos') THEN
    CREATE POLICY definer_insert_eventos ON public.fin_eventos_sistema FOR INSERT WITH CHECK (true);
  END IF;
END $$;

-- 2. Reescrever fn_trigger_repricing_on_cost_change
CREATE OR REPLACE FUNCTION public.fn_trigger_repricing_on_cost_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'vault', 'net'
AS $$
DECLARE
  v_token       text;
  v_request_id  bigint;
  v_url         text := 'https://mgiebypxhnmpktljrzjq.supabase.co/functions/v1/repricing-on-cost-change';
  v_payload     jsonb;
BEGIN
  IF (NEW.valor_custo IS DISTINCT FROM OLD.valor_custo)
     AND NEW.valor_custo IS NOT NULL
     AND NEW.valor_custo > 0
     AND COALESCE(NEW.ativo, true) = true
  THEN
    BEGIN
      SELECT decrypted_secret INTO v_token
      FROM vault.decrypted_secrets
      WHERE name = 'edge_function_invoke_token'
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.fin_eventos_sistema(tipo,severidade,origem,titulo,descricao,payload,entidade_tipo,entidade_id)
      VALUES ('trigger_repricing_falha_vault','critica','fn_trigger_repricing_on_cost_change',
              'Falha ao ler vault.decrypted_secrets',
              'SQLSTATE='||SQLSTATE||' SQLERRM='||SQLERRM,
              jsonb_build_object('produto_gc_id',NEW.produto_gc_id,'sqlerrm',SQLERRM,'sqlstate',SQLSTATE),
              'gc_produtos_cache',NEW.produto_gc_id);
      RETURN NEW;
    END;

    IF v_token IS NULL OR length(v_token) < 10 THEN
      INSERT INTO public.fin_eventos_sistema(tipo,severidade,origem,titulo,descricao,payload,entidade_tipo,entidade_id)
      VALUES ('trigger_repricing_token_vazio','critica','fn_trigger_repricing_on_cost_change',
              'Token vault não encontrado ou inválido',
              'Comprimento do token: '||length(COALESCE(v_token,'')),
              jsonb_build_object('produto_gc_id',NEW.produto_gc_id,'token_length',length(COALESCE(v_token,''))),
              'gc_produtos_cache',NEW.produto_gc_id);
      RETURN NEW;
    END IF;

    v_payload := jsonb_build_object(
      'gc_produto_id', NEW.produto_gc_id,
      'nome_produto',  NEW.nome,
      'custo_anterior', OLD.valor_custo,
      'custo_novo',     NEW.valor_custo
    );

    BEGIN
      SELECT net.http_post(
        url := v_url,
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_token),
        body := v_payload
      ) INTO v_request_id;

      INSERT INTO public.fin_eventos_sistema(tipo,severidade,origem,titulo,descricao,payload,entidade_tipo,entidade_id)
      VALUES ('trigger_repricing_disparado','info','fn_trigger_repricing_on_cost_change',
              'pg_net request enfileirado',
              'Custo '||OLD.valor_custo||' -> '||NEW.valor_custo||' | request_id '||v_request_id,
              jsonb_build_object('produto_gc_id',NEW.produto_gc_id,'pg_net_request_id',v_request_id,
                                 'custo_anterior',OLD.valor_custo,'custo_novo',NEW.valor_custo,'url',v_url),
              'gc_produtos_cache',NEW.produto_gc_id);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.fin_eventos_sistema(tipo,severidade,origem,titulo,descricao,payload,entidade_tipo,entidade_id)
      VALUES ('trigger_repricing_falha_pgnet','critica','fn_trigger_repricing_on_cost_change',
              'Falha ao chamar net.http_post',
              'SQLSTATE='||SQLSTATE||' SQLERRM='||SQLERRM,
              jsonb_build_object('produto_gc_id',NEW.produto_gc_id,'sqlerrm',SQLERRM,'sqlstate',SQLSTATE,'url',v_url),
              'gc_produtos_cache',NEW.produto_gc_id);
    END;
  END IF;
  RETURN NEW;
END;
$$;