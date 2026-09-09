-- Run after migration 20260909220000. All fixtures and audit rows roll back.
BEGIN;
DO $test$
DECLARE
  actor uuid; r1 uuid:=gen_random_uuid(); r2 uuid:=gen_random_uuid(); g1 uuid:=gen_random_uuid(); g2 uuid:=gen_random_uuid();
  answer jsonb; checks integer:=0;
BEGIN
  SELECT user_id INTO actor FROM public.user_roles WHERE role IN ('admin','ceo','gerente_financeiro') ORDER BY user_id LIMIT 1;
  IF actor IS NULL THEN RAISE EXCEPTION 'No financial actor for rollback-only validation'; END IF;
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  INSERT INTO public.fin_recebimentos(id,descricao,origem,tipo,valor,nome_cliente,cliente_gc_id,data_vencimento,liquidado,status)
    VALUES(r1,'TESTE TRANSACIONAL - NÃO PERSISTIR','manual','outro',13771.45,'TESTE TRANSACIONAL','TEST-GROUP-ROLLBACK','2026-09-23',false,'pendente'),
          (r2,'TESTE TRANSACIONAL PAGO - NÃO PERSISTIR','manual','outro',10,'TESTE TRANSACIONAL','TEST-GROUP-ROLLBACK','2026-09-23',true,'pago');
  BEGIN
    PERFORM public.fin_create_receivable_group(g1,'Teste',NULL,ARRAY[r1],'2026-09-23',jsonb_build_object(r1,5271.04),false);
    RAISE EXCEPTION 'TEST: partial unexpectedly accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Valor mudou%' THEN RAISE; END IF; checks:=checks+1;
  END;
  IF EXISTS(SELECT 1 FROM fin_grupos_receber WHERE id=g1) OR EXISTS(SELECT 1 FROM fin_grupo_receber_itens WHERE grupo_id=g1) THEN RAISE EXCEPTION 'TEST: partial left an orphan'; END IF;
  checks:=checks+1;
  answer:=public.fin_create_receivable_group(g1,'Teste',NULL,ARRAY[r1],'2026-09-24',jsonb_build_object(r1,13771.45),true);
  IF answer IS NOT NULL OR EXISTS(SELECT 1 FROM fin_grupos_receber WHERE id=g1) THEN RAISE EXCEPTION 'TEST: preflight mutated'; END IF;
  checks:=checks+1;
  answer:=public.fin_create_receivable_group(g1,'Teste',NULL,ARRAY[r1],'2026-09-24',jsonb_build_object(r1,13771.45),false);
  IF answer->>'id' IS DISTINCT FROM g1::text OR NOT (public.fin_grupo_integrity_facts(g1)->>'completo')::boolean THEN RAISE EXCEPTION 'TEST: complete group missing'; END IF;
  IF (SELECT cliente_gc_id FROM fin_grupos_receber WHERE id=g1) IS DISTINCT FROM 'TEST-GROUP-ROLLBACK' THEN RAISE EXCEPTION 'TEST: client lost'; END IF;
  checks:=checks+2;
  answer:=public.fin_create_receivable_group(g1,'Teste',NULL,ARRAY[r1],'2026-09-24',jsonb_build_object(r1,13771.45),true);
  IF NOT (answer->>'reused')::boolean OR (SELECT count(*) FROM fin_grupo_receber_itens WHERE grupo_id=g1)<>1 THEN RAISE EXCEPTION 'TEST: repeated group duplicated'; END IF;
  checks:=checks+1;
  BEGIN
    PERFORM public.fin_create_receivable_group(g2,'Duplicado',NULL,ARRAY[r1],'2026-09-24',jsonb_build_object(r1,13771.45),false);
    RAISE EXCEPTION 'TEST: duplicate accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Título inexistente%' THEN RAISE; END IF; checks:=checks+1;
  END;
  BEGIN
    PERFORM public.fin_create_receivable_group(g2,'Pago',NULL,ARRAY[r2],'2026-09-24',jsonb_build_object(r2,10),false);
    RAISE EXCEPTION 'TEST: paid title accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Título inexistente%' THEN RAISE; END IF; checks:=checks+1;
  END;
  IF EXISTS(SELECT 1 FROM fin_grupos_receber WHERE id=g2) THEN RAISE EXCEPTION 'TEST: refusal persisted group'; END IF;
  checks:=checks+1;
  IF has_function_privilege('anon','public.fin_create_receivable_group(uuid,text,text,uuid[],date,jsonb,boolean)','EXECUTE') THEN RAISE EXCEPTION 'TEST: anon allowed'; END IF;
  checks:=checks+1;
  PERFORM set_config('wedo.atomic_group_test',jsonb_build_object('checks',checks,'rolled_back',true)::text,true);
END $test$;
SELECT current_setting('wedo.atomic_group_test')::jsonb AS validation;

ROLLBACK;