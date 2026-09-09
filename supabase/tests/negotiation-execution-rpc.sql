-- NO GC CALLS. Deliberate final exception rolls back all fixtures and DDL.
-- The real negotiation sequence is NEVER consumed: the number function is
-- transactionally redirected to a TEMP sequence, then restored by rollback.
DO $rpc_test$
DECLARE
 actor_id uuid;test_job_id uuid;token1 uuid:=gen_random_uuid();token2 uuid:=gen_random_uuid();
 client_id text:='ROLLBACK-CLIENT-'||gen_random_uuid()::text;key1 text:=gen_random_uuid()::text;
 gc1 text:='ROLLBACK-GC-'||gen_random_uuid()::text;gc2 text:='ROLLBACK-GC-'||gen_random_uuid()::text;
 os_id text:='2147471001';original_num int;payload jsonb;plan jsonb;result jsonb;replay jsonb;
 good_result jsonb:='{"success":true,"integrity_verified":true,"summary":{"ok":1,"errors":0}}';
 bad_result jsonb:='{"success":false,"error":"ROLLBACK TEST controlled failure","summary":{"ok":0,"errors":1}}';
 caught boolean;checks int:=0;group_id uuid;
BEGIN
 PERFORM set_config('lock_timeout','5s',true);
 PERFORM set_config('statement_timeout','60s',true);
 PERFORM set_config('wedo.audit_repair_batch','',true);
 PERFORM set_config('wedo.negotiation_finalize_job','',true);
 PERFORM set_config('wedo.residual_release_authorized','',true);
 SELECT user_id INTO actor_id FROM public.user_roles WHERE role::text IN ('admin','ceo','gerente_financeiro') ORDER BY user_id LIMIT 1;
 IF actor_id IS NULL THEN RAISE EXCEPTION 'RPC_TEST_SETUP_FAILED: no existing financial user; no writes performed';END IF;
 EXECUTE 'CREATE TEMP SEQUENCE negotiation_test_numbers START 2147470000';
 EXECUTE $override$
   CREATE OR REPLACE FUNCTION public.next_negociacao_number() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=public
   AS $body$ SELECT nextval('pg_temp.negotiation_test_numbers')::integer $body$
 $override$;
 IF to_regprocedure('public.fin_persist_negotiation(uuid,jsonb)') IS NOT NULL
   OR to_regprocedure('public.fin_finalize_negotiation(uuid,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'FAIL unfenced RPC overload remains';END IF;checks:=checks+1;
 IF has_function_privilege('authenticated','public.fin_enqueue_negotiation(jsonb,text,uuid)','EXECUTE')
   OR has_function_privilege('authenticated','public.fin_persist_negotiation(uuid,jsonb,uuid)','EXECUTE')
   OR has_function_privilege('authenticated','public.fin_finalize_negotiation(uuid,jsonb,uuid)','EXECUTE') THEN RAISE EXCEPTION 'FAIL browser can call service-only execution RPC';END IF;checks:=checks+1;
 payload:=jsonb_build_object('cliente_gc_id',client_id,'nome_cliente','ROLLBACK TEST CLIENT','os_ids',jsonb_build_array(os_id),'residual_ids','[]'::jsonb);
 caught:=false;BEGIN PERFORM public.fin_enqueue_negotiation(payload,key1,NULL);EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL missing financial actor accepted';END IF;checks:=checks+1;
 result:=public.fin_enqueue_negotiation(payload,key1,actor_id);test_job_id:=(result->>'job_id')::uuid;original_num:=(result->>'negociacao_numero')::int;
 IF test_job_id IS NULL OR result->>'status'<>'pendente' THEN RAISE EXCEPTION 'FAIL enqueue did not create pending job';END IF;checks:=checks+1;
 replay:=public.fin_enqueue_negotiation(payload,key1,actor_id);
 IF (replay->>'job_id')::uuid<>test_job_id OR (replay->>'reused')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL idempotent replay created another job';END IF;checks:=checks+1;
 caught:=false;BEGIN PERFORM public.fin_enqueue_negotiation(payload||'{"changed":true}',key1,actor_id);EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL same key accepted changed request';END IF;checks:=checks+1;
 caught:=false;BEGIN PERFORM public.fin_enqueue_negotiation(payload,gen_random_uuid()::text,actor_id);EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL same origin reserved by another job';END IF;checks:=checks+1;
 IF public.fin_claim_negotiation_execution(test_job_id,token1) IS NOT TRUE OR public.fin_claim_negotiation_execution(test_job_id,token2) IS NOT FALSE THEN RAISE EXCEPTION 'FAIL concurrent execution claim';END IF;checks:=checks+1;
 plan:=jsonb_build_object('version',2,'negociacao_numero',original_num,'cliente_gc_id',client_id,'nome_cliente','ROLLBACK TEST CLIENT',
  'origins',jsonb_build_array(jsonb_build_object('origin_key','os:'||os_id,'available_cents',10000)),
  'parcelas',jsonb_build_array(jsonb_build_object('numero',1,'data_vencimento','2026-12-01','valor_cents',6000,
    'items',jsonb_build_array(jsonb_build_object('origin_key','os:'||os_id,'gc_id',gc1,'os_codigo','ROLLBACK-OS-A','valor_cents',6000,
      'recebimento',jsonb_build_object('id',gc1,'codigo','ROLLBACK-A','descricao','ROLLBACK INSTALLMENT','cliente_id',client_id,
        'valor','60.00','valor_total','60.00','liquidado','0','data_vencimento','2026-12-01','data_competencia','2026-09-01'))))),
  'residuos',jsonb_build_array(jsonb_build_object('origin_key','os:'||os_id,'gc_id',gc2,'os_codigos',jsonb_build_array('ROLLBACK-OS-A'),
    'valor_cents',4000,'data_vencimento','2027-01-01','recebimento',jsonb_build_object('id',gc2,'codigo','ROLLBACK-B',
      'descricao','ROLLBACK RESIDUAL','cliente_id',client_id,'valor','40.00','valor_total','40.00','liquidado','0',
      'data_vencimento','2027-01-01','data_competencia','2026-09-01'))),
  'consumed_residual_ids','[]'::jsonb,'negotiated_cents',6000,'remaining_cents',4000,'total_original_cents',10000);
 caught:=false;BEGIN PERFORM public.fin_persist_negotiation(test_job_id,plan,NULL);EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL persist without fence accepted';END IF;checks:=checks+1;
 caught:=false;BEGIN PERFORM public.fin_persist_negotiation(test_job_id,jsonb_set(plan,'{cliente_gc_id}','"WRONG"'),token1);EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL foreign-client plan accepted';END IF;checks:=checks+1;
 caught:=false;BEGIN PERFORM public.fin_persist_negotiation(test_job_id,jsonb_set(plan,'{parcelas,0,items,0,recebimento,liquidado}','"1"'),token1);EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL paid title accepted';END IF;checks:=checks+1;
 caught:=false;BEGIN PERFORM public.fin_persist_negotiation(test_job_id,jsonb_set(plan,'{parcelas,0,items,0,recebimento,valor_total}','"600.00"'),token1);EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL divergent title amount accepted';END IF;checks:=checks+1;
 caught:=false;BEGIN PERFORM public.fin_persist_negotiation(test_job_id,jsonb_set(plan,'{residuos,0,recebimento,data_vencimento}','"2027-02-01"'),token1);EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL divergent residual due date accepted';END IF;checks:=checks+1;
 IF EXISTS(SELECT 1 FROM fin_grupos_receber WHERE negociacao_job_id=test_job_id) OR EXISTS(SELECT 1 FROM fin_recebimentos WHERE gc_id IN(gc1,gc2)) THEN RAISE EXCEPTION 'FAIL invalid plan left partial financial rows';END IF;checks:=checks+1;
 result:=public.fin_persist_negotiation(test_job_id,plan,token1);group_id:=(result#>>'{grupo_ids,0}')::uuid;
 IF group_id IS NULL OR NOT EXISTS(SELECT 1 FROM fin_grupos_receber WHERE id=group_id AND valor_total=60 AND integridade_status='pendente' AND bloqueio_financeiro) THEN RAISE EXCEPTION 'FAIL group was not atomically persisted blocked';END IF;checks:=checks+1;
 IF NOT EXISTS(SELECT 1 FROM fin_residuos_negociacao WHERE gc_recebimento_id=gc2 AND valor_residual=40 AND estado='reservado' AND utilizado) THEN RAISE EXCEPTION 'FAIL new residual became selectable before verification';END IF;checks:=checks+1;
 replay:=public.fin_persist_negotiation(test_job_id,plan,token1);
 IF (replay->>'reused')::boolean IS NOT TRUE OR (SELECT count(*) FROM fin_grupos_receber WHERE negociacao_job_id=test_job_id)<>1 THEN RAISE EXCEPTION 'FAIL persist replay duplicates groups';END IF;checks:=checks+1;
 UPDATE fin_negociacao_jobs SET execution_state='{"checkpoint":"must-survive-resume"}' WHERE id=test_job_id;
 result:=public.fin_finalize_negotiation(test_job_id,bad_result,token1);
 IF result->>'status'<>'erro' OR NOT EXISTS(SELECT 1 FROM fin_grupos_receber WHERE id=group_id AND bloqueio_financeiro)
   OR NOT EXISTS(SELECT 1 FROM fin_residuos_negociacao WHERE gc_recebimento_id=gc2 AND estado='reservado' AND utilizado) THEN RAISE EXCEPTION 'FAIL failure released agreement/residual';END IF;checks:=checks+1;
 replay:=public.fin_resume_negotiation(test_job_id,actor_id);
 IF replay->>'status'<>'pendente' OR (replay->>'negociacao_numero')::int<>original_num
   OR NOT EXISTS(SELECT 1 FROM fin_negociacao_jobs WHERE id=test_job_id AND execution_token IS NULL AND execution_state->>'checkpoint'='must-survive-resume' AND persisted_plan_hash IS NOT NULL) THEN RAISE EXCEPTION 'FAIL resume replaced number, plan or journal';END IF;checks:=checks+1;
 IF public.fin_claim_negotiation_execution(test_job_id,token2) IS NOT TRUE THEN RAISE EXCEPTION 'FAIL resumed job could not be claimed';END IF;checks:=checks+1;
 caught:=false;BEGIN PERFORM public.fin_persist_negotiation(test_job_id,plan,token1);EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL stale owner persisted after resume';END IF;checks:=checks+1;
 caught:=false;BEGIN PERFORM public.fin_finalize_negotiation(test_job_id,good_result,token1);EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL stale owner finalized after resume';END IF;checks:=checks+1;
 replay:=public.fin_persist_negotiation(test_job_id,plan,token2);
 IF (replay->>'reused')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL new owner could not reuse exact persisted plan';END IF;checks:=checks+1;
 result:=public.fin_finalize_negotiation(test_job_id,good_result,token2);
 IF result->>'status'<>'concluido' OR NOT EXISTS(SELECT 1 FROM fin_grupos_receber WHERE id=group_id AND integridade_status='ok' AND NOT bloqueio_financeiro AND status='aberto')
   OR NOT EXISTS(SELECT 1 FROM fin_residuos_negociacao WHERE gc_recebimento_id=gc2 AND estado='disponivel' AND NOT utilizado)
   OR NOT EXISTS(SELECT 1 FROM fin_negociacao_reservas reserved WHERE reserved.job_id=test_job_id AND origin_key='os:'||os_id AND estado='consumido') THEN RAISE EXCEPTION 'FAIL verified finalization did not release only own new residual';END IF;checks:=checks+1;
 caught:=false;BEGIN PERFORM public.fin_finalize_negotiation(test_job_id,good_result,token1);EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL stale owner bypassed fence through completed replay';END IF;checks:=checks+1;
 replay:=public.fin_finalize_negotiation(test_job_id,good_result,token2);
 IF (replay->>'reused')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL completed finalization not idempotent';END IF;checks:=checks+1;
 caught:=false;BEGIN PERFORM public.fin_resume_negotiation(test_job_id,actor_id);EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL completed job resumed';END IF;checks:=checks+1;
 IF (SELECT count(*) FROM fin_recebimentos WHERE gc_id IN(gc1,gc2))<>2
   OR (SELECT sum(valor) FROM fin_recebimentos WHERE gc_id IN(gc1,gc2))<>100 THEN RAISE EXCEPTION 'FAIL title identity or value conservation after replay';END IF;checks:=checks+1;
 RAISE EXCEPTION 'NEGOTIATION_RPC_TESTS_PASSED: % checks; forced rollback restores fixtures AND original number function; real sequence untouched',checks;
END;
$rpc_test$;
