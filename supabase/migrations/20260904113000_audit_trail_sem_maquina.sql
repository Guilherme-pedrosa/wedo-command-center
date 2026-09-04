-- audit_trail: parar de auditar escrita de máquina.
--
-- Em 04/09/2026 a tabela public.audit_trail tinha 19,2 milhões de linhas e 47 GB (o banco
-- inteiro). 99% vinham do trigger fn_audit_trail_generic disparado pelos syncs do GestãoClick
-- (os_index, gc_pagamentos, fin_pagamentos, gc_vendas, gc_compras_itens…), que rodam a cada
-- 30 min com service role (auth.uid() nulo) e regravam before/after/diff em jsonb de cada
-- linha — built_at/last_synced_at não estavam na lista de campos ignorados. Isso deixava
-- cada upsert do sync em ~180 ms e a instância (pequena) no limite do statement_timeout.
--
-- Regra nova: sem usuário autenticado não há o que auditar (a fonte é o sistema externo).
-- Edições humanas continuam auditadas em todas as tabelas. Os campos de carimbo de sync
-- entram na lista de ignorados. A limpeza da tabela (mantidas só as linhas com usuário) foi
-- feita manualmente no mesmo dia; não faz parte desta migration.

CREATE OR REPLACE FUNCTION public.fn_audit_trail_generic()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id  uuid := auth.uid();
  v_email    text;
  v_role     text;
  v_before   jsonb;
  v_after    jsonb;
  v_diff     jsonb;
  v_record_id text;
BEGIN
  -- Escrita de máquina (syncs, crons, edge functions com service role): não audita.
  IF v_user_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT email INTO v_email FROM public.profiles WHERE id = v_user_id;
  SELECT string_agg(role::text, ',') INTO v_role FROM public.user_roles WHERE user_id = v_user_id;

  IF TG_OP = 'DELETE' THEN
    v_before := to_jsonb(OLD);
    v_record_id := COALESCE((v_before->>'id'), (v_before->>'gc_id'), '');
  ELSIF TG_OP = 'INSERT' THEN
    v_after := to_jsonb(NEW);
    v_record_id := COALESCE((v_after->>'id'), (v_after->>'gc_id'), '');
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
    v_record_id := COALESCE((v_after->>'id'), (v_after->>'gc_id'), '');

    -- Calcula apenas campos alterados (carimbos de sync não contam como mudança)
    SELECT jsonb_object_agg(key, jsonb_build_object('before', v_before->key, 'after', v_after->key))
    INTO v_diff
    FROM (
      SELECT key FROM jsonb_object_keys(v_after) AS key
      WHERE (v_before->key) IS DISTINCT FROM (v_after->key)
        AND key NOT IN ('updated_at','sync_at','last_sync','last_updated_at','built_at','last_synced_at','synced_at','last_sync_at')
    ) t;

    -- Se só mudou metadado, não loga
    IF v_diff IS NULL OR v_diff = '{}'::jsonb THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO public.audit_trail (
    user_id, user_email, user_role,
    action_type, action,
    table_name, record_id,
    before_data, after_data, diff,
    severity
  ) VALUES (
    v_user_id, v_email, v_role,
    'data', TG_OP,
    TG_TABLE_NAME, NULLIF(v_record_id,''),
    v_before, v_after, v_diff,
    CASE WHEN TG_OP = 'DELETE' THEN 'warning' ELSE 'info' END
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  -- Nunca bloqueia a operação por falha de auditoria
  RAISE WARNING 'audit_trail falhou em %.%: %', TG_TABLE_NAME, TG_OP, SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$function$;
