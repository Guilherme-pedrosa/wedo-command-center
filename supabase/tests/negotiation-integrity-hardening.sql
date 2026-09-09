-- Run only in a disposable database or a transaction that will be rolled back.
-- The final deliberate exception proves all earlier assertions passed and
-- rolls back EVERY fixture/audit row. Never remove the final exception.
DO $test$
DECLARE
 g1 uuid:=gen_random_uuid();g2 uuid:=gen_random_uuid();g_job uuid:=gen_random_uuid();
 r1 uuid:=gen_random_uuid();r2 uuid:=gen_random_uuid();r3 uuid:=gen_random_uuid();r4 uuid:=gen_random_uuid();
 j1 uuid:=gen_random_uuid();z1 uuid:=gen_random_uuid();caught boolean;facts jsonb;status_now text;checks int:=0;
 gc1 text:='TEST-'||gen_random_uuid()::text;gc2 text:='TEST-'||gen_random_uuid()::text;
 gc3 text:='TEST-'||gen_random_uuid()::text;gc4 text:='TEST-'||gen_random_uuid()::text;
BEGIN
 PERFORM set_config('lock_timeout','5s',true);
 PERFORM set_config('statement_timeout','60s',true);
 PERFORM set_config('wedo.audit_repair_batch','',true);
 PERFORM set_config('wedo.negotiation_finalize_job','',true);
 PERFORM set_config('wedo.residual_release_authorized','',true);
 IF public.fn_negotiation_repair_context() IS NOT FALSE THEN RAISE EXCEPTION 'FAIL repair context must fail closed';END IF;checks:=checks+1;
 IF has_table_privilege('authenticated','public.fin_negociacao_jobs','INSERT')
   OR has_table_privilege('authenticated','public.fin_negociacao_jobs','UPDATE')
   OR has_table_privilege('authenticated','public.fin_negociacao_jobs','DELETE') THEN RAISE EXCEPTION 'FAIL browser job write permissions';END IF;checks:=checks+1;
 -- Seed pre-existing historical groups through the narrow admin repair context.
 PERFORM set_config('wedo.audit_repair_batch','negociacao-repair-2026-09-09-v1',true);
 INSERT INTO fin_grupos_receber(id,nome,cliente_gc_id,valor_total,negociacao_numero,os_codigos,itens_total,status)
 VALUES(g1,'INTEGRITY ROLLBACK TEST','TEST-CLIENT',100,2147480101,ARRAY['TEST-A','TEST-B'],2,'aberto'),
       (g2,'INTEGRITY ROLLBACK TEST2','TEST-CLIENT',40,2147480102,ARRAY['TEST-A'],1,'aberto');
 PERFORM set_config('wedo.audit_repair_batch','',true);
 INSERT INTO fin_recebimentos(id,gc_id,descricao,os_codigo,cliente_gc_id,valor,status,liquidado,gc_baixado,data_liquidacao)
 VALUES(r1,gc1,'INTEGRITY ROLLBACK TEST A','TEST-A','TEST-CLIENT',40,'pago',true,true,'2026-08-01'),
       (r2,gc2,'INTEGRITY ROLLBACK TEST B','TEST-B','TEST-CLIENT',60,'pendente',false,false,NULL),
       (r3,gc3,'INTEGRITY ROLLBACK RESIDUAL','TEST-C','TEST-CLIENT',10,'pendente',false,false,NULL),
       (r4,gc4,'INTEGRITY ROLLBACK NEW JOB','TEST-D','TEST-CLIENT',10,'pendente',false,false,NULL);
 INSERT INTO fin_grupo_receber_itens(grupo_id,recebimento_id,valor,os_codigo_original,snapshot_valor,snapshot_data)
 VALUES(g1,r1,40,'TEST-A',40,'2026-08-01');
 UPDATE fin_recebimentos SET grupo_id=g1 WHERE id=r1;
 caught:=false;BEGIN UPDATE fin_grupos_receber SET integridade_status='ok' WHERE id=g1;EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL incomplete paid subset released';END IF;checks:=checks+1;
 INSERT INTO fin_grupo_receber_itens(grupo_id,recebimento_id,valor,os_codigo_original,snapshot_valor,snapshot_data)
 VALUES(g1,r2,60,'TEST-B',60,'2026-08-01');
 facts:=public.fin_grupo_integrity_facts(g1);
 IF coalesce((facts->>'ponteiros_ok')::boolean,true) OR coalesce((facts->>'completo')::boolean,true) THEN
  RAISE EXCEPTION 'FAIL one NULL pointer was ignored among valid pointers';END IF;checks:=checks+1;
 UPDATE fin_recebimentos SET grupo_id=g1 WHERE id=r2;
 UPDATE fin_grupos_receber SET integridade_status='ok' WHERE id=g1;
 SELECT status::text INTO status_now FROM fin_grupos_receber WHERE id=g1;
 IF status_now<>'pago_parcial' THEN RAISE EXCEPTION 'FAIL partial liquidation must be partial, got %',status_now;END IF;checks:=checks+1;
 caught:=false;BEGIN UPDATE fin_grupos_receber SET status=NULL WHERE id=g1;EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL NULL status accepted';END IF;checks:=checks+1;
 caught:=false;BEGIN UPDATE fin_grupos_receber SET status='pago' WHERE id=g1;EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL false full liquidation accepted';END IF;checks:=checks+1;
 caught:=false;BEGIN DELETE FROM fin_grupo_receber_itens WHERE grupo_id=g1 AND recebimento_id=r1;EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL negotiated item deleted';END IF;checks:=checks+1;
 caught:=false;BEGIN DELETE FROM fin_grupos_receber WHERE id=g1;EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL negotiated group deleted';END IF;checks:=checks+1;
 caught:=false;BEGIN DELETE FROM fin_recebimentos WHERE id=r1;EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL linked receipt deleted';END IF;checks:=checks+1;
 caught:=false;BEGIN UPDATE fin_recebimentos SET grupo_id=NULL WHERE id=r1;EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL sync detached receipt';END IF;checks:=checks+1;
 caught:=false;BEGIN UPDATE fin_recebimentos SET gc_id=NULL WHERE id=r1;EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL GC identity removed';END IF;checks:=checks+1;
 caught:=false;BEGIN UPDATE fin_grupo_receber_itens SET snapshot_valor=999 WHERE recebimento_id=r1;EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL immutable snapshot changed';END IF;checks:=checks+1;
 caught:=false;BEGIN INSERT INTO fin_grupo_receber_itens(grupo_id,recebimento_id,valor,os_codigo_original,snapshot_valor) VALUES(g2,r1,40,'TEST-A',40);EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL second active receipt link accepted';END IF;checks:=checks+1;
 UPDATE fin_recebimentos SET liquidado=true,status='pago',gc_baixado=true,data_liquidacao='2026-08-02' WHERE id=r2;
 IF NOT EXISTS(SELECT 1 FROM fin_grupos_receber WHERE id=g1 AND status='pago' AND data_pagamento::date=date '2026-08-02') THEN
  RAISE EXCEPTION 'FAIL payment date must use source liquidation date, not now';END IF;checks:=checks+1;
 INSERT INTO fin_residuos_negociacao(id,cliente_gc_id,nome_cliente,valor_residual,negociacao_origem_numero,gc_recebimento_id,os_codigos,estado,utilizado)
 VALUES(z1,'TEST-CLIENT','INTEGRITY ROLLBACK TEST',10,2147480103,gc3,ARRAY['TEST-C'],'disponivel',false);
 UPDATE fin_residuos_negociacao SET estado='reservado' WHERE id=z1;
 UPDATE fin_residuos_negociacao SET utilizado=false WHERE id=z1;
 IF NOT EXISTS(SELECT 1 FROM fin_residuos_negociacao WHERE id=z1 AND estado='reservado' AND utilizado) THEN RAISE EXCEPTION 'FAIL nonavailable residual reopened through legacy flag';END IF;checks:=checks+1;
 caught:=false;BEGIN UPDATE fin_residuos_negociacao SET estado='disponivel',utilizado=false WHERE id=z1;EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL reservation released without controlled context';END IF;checks:=checks+1;
 UPDATE fin_recebimentos SET liquidado=true,status='pago',data_liquidacao='2026-08-03' WHERE id=r3;
 IF NOT EXISTS(SELECT 1 FROM fin_residuos_negociacao WHERE id=z1 AND estado='liquidado' AND utilizado) THEN RAISE EXCEPTION 'FAIL paid residual was not removed from selection';END IF;checks:=checks+1;
 caught:=false;BEGIN UPDATE fin_residuos_negociacao SET estado='disponivel',utilizado=false WHERE id=z1;EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL paid residual reopened';END IF;checks:=checks+1;
 caught:=false;BEGIN UPDATE fin_residuos_negociacao SET negociacao_origem_numero=NULL WHERE id=z1;EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL residual origin erased';END IF;checks:=checks+1;
 INSERT INTO fin_negociacao_jobs(id,payload,idempotency_key,status,execution_token,persisted_plan_hash,resultado)
 VALUES(j1,'{}',gen_random_uuid()::text,'processando',gen_random_uuid(),'ROLLBACK-TEST',
  '{"success":true,"integrity_verified":true,"summary":{"errors":0}}');
 caught:=false;BEGIN UPDATE fin_negociacao_jobs SET payload='{"changed":true}' WHERE id=j1;EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL captured job payload changed';END IF;checks:=checks+1;
 UPDATE fin_grupos_receber SET integridade_status='pendente',bloqueio_financeiro=true WHERE id=g1;
 PERFORM set_config('wedo.negotiation_finalize_job',j1::text,true);
 caught:=false;BEGIN UPDATE fin_grupos_receber SET integridade_status='ok',bloqueio_financeiro=false WHERE id=g1;EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'FAIL finalize context released historical group';END IF;checks:=checks+1;
 INSERT INTO fin_grupos_receber(id,nome,cliente_gc_id,valor_total,negociacao_numero,negociacao_job_id,os_codigos,itens_total,status,integridade_status,bloqueio_financeiro)
 VALUES(g_job,'INTEGRITY ROLLBACK NEW JOB','TEST-CLIENT',10,2147480104,j1,ARRAY['TEST-D'],1,'aberto','pendente',true);
 INSERT INTO fin_grupo_receber_itens(grupo_id,recebimento_id,valor,os_codigo_original,snapshot_valor,snapshot_data)
 VALUES(g_job,r4,10,'TEST-D',10,'2026-08-01');
 UPDATE fin_recebimentos SET grupo_id=g_job WHERE id=r4;
 UPDATE fin_grupos_receber SET integridade_status='ok',bloqueio_financeiro=false WHERE id=g_job;
 IF NOT EXISTS(SELECT 1 FROM fin_grupos_receber WHERE id=g_job AND integridade_status='ok' AND NOT bloqueio_financeiro) THEN RAISE EXCEPTION 'FAIL verified job could not finalize own group';END IF;checks:=checks+1;
 UPDATE fin_recebimentos SET valor=11 WHERE id=r4;
 IF NOT EXISTS(SELECT 1 FROM fin_grupos_receber WHERE id=g_job AND valor_total=10 AND integridade_status='pendente' AND bloqueio_financeiro)
    OR NOT EXISTS(SELECT 1 FROM fin_grupo_receber_itens WHERE recebimento_id=r4 AND snapshot_valor=10) THEN RAISE EXCEPTION 'FAIL changed title did not preserve/block original agreement';END IF;checks:=checks+1;
 IF NOT EXISTS(SELECT 1 FROM fin_audit_log WHERE entidade_id=g_job::text AND acao LIKE 'negociacao_integridade_%') THEN RAISE EXCEPTION 'FAIL machine audit missing';END IF;checks:=checks+1;
 RAISE EXCEPTION 'INTEGRITY_TESTS_PASSED: % checks; forced rollback of every test fixture and audit row',checks;
END;
$test$;
