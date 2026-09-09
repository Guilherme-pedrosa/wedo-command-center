-- Integrity of agreements is independent of the current ERP title snapshot.
-- This migration performs no historical financial repair and no external call.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.fin_grupos_receber ADD COLUMN IF NOT EXISTS integridade_status text NOT NULL DEFAULT 'nao_verificado';
ALTER TABLE public.fin_grupos_receber ADD COLUMN IF NOT EXISTS integridade_motivos jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.fin_grupos_receber ADD COLUMN IF NOT EXISTS bloqueio_financeiro boolean NOT NULL DEFAULT false;
ALTER TABLE public.fin_residuos_negociacao ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'pendente_vinculo';
ALTER TABLE public.fin_negociacao_jobs ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.fin_negociacao_jobs ADD COLUMN IF NOT EXISTS created_by_user uuid;
ALTER TABLE public.fin_negociacao_jobs ADD COLUMN IF NOT EXISTS execution_token uuid;
ALTER TABLE public.fin_negociacao_jobs ADD COLUMN IF NOT EXISTS persisted_plan_hash text;
ALTER TABLE public.fin_grupos_receber ADD COLUMN IF NOT EXISTS negociacao_job_id uuid REFERENCES public.fin_negociacao_jobs(id);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.fin_grupos_receber'::regclass AND conname='fin_grupos_receber_integridade_status_valid') THEN
  ALTER TABLE public.fin_grupos_receber ADD CONSTRAINT fin_grupos_receber_integridade_status_valid
   CHECK(integridade_status IN ('nao_verificado','pendente','ok') AND integridade_status IS NOT NULL) NOT VALID;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.fin_residuos_negociacao'::regclass AND conname='fin_residuos_negociacao_estado_valid') THEN
  ALTER TABLE public.fin_residuos_negociacao ADD CONSTRAINT fin_residuos_negociacao_estado_valid
   CHECK(estado IN ('disponivel','reservado','alocado','liquidado','pendente_vinculo','em_revisao') AND estado IS NOT NULL) NOT VALID;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_negotiation_repair_context()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT coalesce(session_user IN ('postgres','supabase_admin')
     AND current_user IN ('postgres','supabase_admin')
     AND current_setting('wedo.audit_repair_batch',true)='negociacao-repair-2026-09-09-v1',false)
$$;

CREATE OR REPLACE FUNCTION public.fn_negotiation_backend_context()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT coalesce(auth.role()='service_role',false)
      OR current_user IN ('postgres','supabase_admin')
$$;

-- Facts do not mutate agreements or infer a missing title from a sum.
CREATE OR REPLACE FUNCTION public.fin_grupo_integrity_facts(p_grupo_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH members AS (
  SELECT i.id,i.valor,i.os_codigo_original,r.id AS recebimento_id,r.gc_id,r.grupo_id,r.cliente_gc_id,
    coalesce(i.os_codigo_original,r.os_codigo) AS os_codigo,
    CASE WHEN r.gc_id IS NOT NULL THEN coalesce(r.liquidado,false)
      ELSE r.status='pago' AND coalesce(r.pago_sistema,false)
        AND coalesce((SELECT sum(a.valor_alocado) FROM fin_extrato_lancamentos a
          WHERE a.tabela='recebimentos' AND a.lancamento_id=r.id),0)>=r.valor END AS pago,
    (r.gc_id IS NOT NULL AND coalesce(r.liquidado,false)) AS gc_pago,r.data_liquidacao,
    EXISTS(SELECT 1 FROM fin_grupo_receber_itens other_i JOIN fin_grupos_receber other_g ON other_g.id=other_i.grupo_id
      WHERE other_i.recebimento_id=r.id AND other_i.grupo_id<>p_grupo_id AND other_g.status<>'cancelado') AS outro_ativo
  FROM fin_grupo_receber_itens i JOIN fin_recebimentos r ON r.id=i.recebimento_id WHERE i.grupo_id=p_grupo_id
 ), stats AS (
  SELECT count(*)::int AS total,count(*) FILTER(WHERE pago)::int AS pagos,
    count(*) FILTER(WHERE gc_pago)::int AS gc_pagos,
    count(*) FILTER(WHERE data_liquidacao IS NOT NULL)::int AS datas_conhecidas,
    max(data_liquidacao) AS ultima_liquidacao,coalesce(sum(valor),0) AS soma,
    coalesce(bool_and(coalesce(grupo_id=p_grupo_id,false)),false) AS ponteiros_ok,
    coalesce(bool_or(outro_ativo),false) AS duplicado,
    coalesce(array_agg(DISTINCT os_codigo ORDER BY os_codigo) FILTER(WHERE os_codigo IS NOT NULL),'{}'::text[]) AS os_atuais
  FROM members
 )
 SELECT jsonb_build_object('total',s.total,'pagos',s.pagos,'gc_pagos',s.gc_pagos,'soma',s.soma,
   'datas_conhecidas',s.datas_conhecidas,'ultima_liquidacao',s.ultima_liquidacao,
   'completo',s.total>0 AND NOT s.duplicado AND s.ponteiros_ok AND round(s.soma,2)=round(g.valor_total,2)
     AND (g.itens_total IS NULL OR g.itens_total=0 OR g.itens_total=s.total)
     AND (g.negociacao_numero IS NULL OR (
       g.itens_total>0 AND cardinality(g.os_codigos)>0
       AND s.os_atuais=ARRAY(SELECT DISTINCT code FROM unnest(g.os_codigos) code ORDER BY code)
       AND NOT EXISTS(SELECT 1 FROM members m WHERE m.cliente_gc_id IS DISTINCT FROM g.cliente_gc_id))),
   'duplicado',s.duplicado,'ponteiros_ok',s.ponteiros_ok,'os_atuais',s.os_atuais)
 FROM fin_grupos_receber g CROSS JOIN stats s WHERE g.id=p_grupo_id
$$;
REVOKE ALL ON FUNCTION public.fin_grupo_integrity_facts(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fin_grupo_integrity_facts(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_refresh_grupo_receber_integrity(p_grupo_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE grp public.fin_grupos_receber%ROWTYPE; facts jsonb; next_status public.fin_status_grupo;
BEGIN
 SELECT * INTO grp FROM fin_grupos_receber WHERE id=p_grupo_id FOR UPDATE;
 IF NOT FOUND OR grp.status='cancelado' OR coalesce(grp.bloqueio_financeiro,false)
   OR coalesce(grp.integridade_status,'nao_verificado')<>'ok' THEN RETURN; END IF;
 facts:=public.fin_grupo_integrity_facts(p_grupo_id);
 IF coalesce((facts->>'completo')::boolean,false) IS NOT TRUE THEN
  UPDATE fin_grupos_receber SET integridade_status='pendente',bloqueio_financeiro=true,
   integridade_motivos=coalesce(integridade_motivos,'[]'::jsonb)||jsonb_build_array(jsonb_build_object(
     'codigo','composicao_incompleta','mensagem','Composição, OS, valores, cliente ou vínculos divergem do acordo. Conferência necessária.','fatos',facts)),
   updated_at=now() WHERE id=p_grupo_id;
  RETURN;
 END IF;
 next_status:=CASE WHEN (facts->>'pagos')::int=(facts->>'total')::int THEN 'pago'
   WHEN (facts->>'pagos')::int>0 THEN 'pago_parcial' ELSE 'aberto' END;
 UPDATE fin_grupos_receber SET status=next_status,itens_baixados=(facts->>'pagos')::int,
  gc_baixado=((facts->>'gc_pagos')::int=(facts->>'total')::int),
  gc_baixado_em=CASE WHEN (facts->>'gc_pagos')::int=(facts->>'total')::int
      AND (facts->>'datas_conhecidas')::int=(facts->>'total')::int
    THEN (facts->>'ultima_liquidacao')::date::timestamptz ELSE NULL END,
  data_pagamento=CASE WHEN next_status='pago' AND (facts->>'datas_conhecidas')::int=(facts->>'total')::int
    THEN coalesce(data_pagamento,(facts->>'ultima_liquidacao')::date::timestamptz)
    WHEN next_status<>'pago' THEN NULL ELSE data_pagamento END,
  updated_at=now()
 WHERE id=p_grupo_id AND (status IS DISTINCT FROM next_status
   OR itens_baixados IS DISTINCT FROM (facts->>'pagos')::int
   OR gc_baixado IS DISTINCT FROM ((facts->>'gc_pagos')::int=(facts->>'total')::int));
END $$;
REVOKE ALL ON FUNCTION public.fn_refresh_grupo_receber_integrity(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_refresh_grupo_receber_integrity(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_sync_grupo_receber_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target_id uuid;
BEGIN
 -- The item relation is authoritative. Refresh both groups when a pointer changes.
 FOR target_id IN SELECT DISTINCT g_id FROM (
   SELECT OLD.grupo_id AS g_id UNION SELECT NEW.grupo_id
   UNION SELECT i.grupo_id FROM fin_grupo_receber_itens i WHERE i.recebimento_id=NEW.id
 ) candidates WHERE g_id IS NOT NULL LOOP
   PERFORM public.fn_refresh_grupo_receber_integrity(target_id);
 END LOOP;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_sync_grupo_receber_status ON public.fin_recebimentos;
CREATE TRIGGER trg_sync_grupo_receber_status AFTER UPDATE OF status,liquidado,grupo_id,valor,data_liquidacao
 ON public.fin_recebimentos FOR EACH ROW EXECUTE FUNCTION public.fn_sync_grupo_receber_status();

CREATE OR REPLACE FUNCTION public.fn_sync_grupo_item_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN PERFORM public.fn_refresh_grupo_receber_integrity(OLD.grupo_id); END IF;
 IF TG_OP<>'DELETE' AND (TG_OP='INSERT' OR NEW.grupo_id IS DISTINCT FROM OLD.grupo_id) THEN
   PERFORM public.fn_refresh_grupo_receber_integrity(NEW.grupo_id);
 END IF;
 RETURN coalesce(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS trg_sync_grupo_item_integrity ON public.fin_grupo_receber_itens;
CREATE TRIGGER trg_sync_grupo_item_integrity AFTER INSERT OR DELETE OR UPDATE ON public.fin_grupo_receber_itens
 FOR EACH ROW EXECUTE FUNCTION public.fn_sync_grupo_item_integrity();

CREATE OR REPLACE FUNCTION public.fn_guard_negotiated_item()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE target_receipt uuid; target_group uuid; old_neg int; target_neg int; target_status public.fin_status_grupo;
BEGIN
 IF TG_OP<>'INSERT' THEN
  SELECT negociacao_numero INTO old_neg FROM fin_grupos_receber WHERE id=OLD.grupo_id;
  IF TG_OP='DELETE' AND (old_neg IS NOT NULL OR EXISTS(SELECT 1 FROM fin_recebimentos r WHERE r.id=OLD.recebimento_id
       AND (r.liquidado OR r.status='pago')) OR EXISTS(SELECT 1 FROM fin_extrato_lancamentos a WHERE a.lancamento_id=OLD.recebimento_id)) THEN
   RAISE EXCEPTION 'Item de negociação/recebimento preservado; solicite revisão auditável, sem exclusão física.';
  END IF;
  IF TG_OP='UPDATE' AND old_neg IS NOT NULL AND NOT public.fn_negotiation_repair_context()
    AND (ROW(NEW.grupo_id,NEW.recebimento_id,NEW.valor,NEW.os_codigo_original,NEW.snapshot_valor,NEW.snapshot_data)
      IS DISTINCT FROM ROW(OLD.grupo_id,OLD.recebimento_id,OLD.valor,OLD.os_codigo_original,OLD.snapshot_valor,OLD.snapshot_data)) THEN
   RAISE EXCEPTION 'Composição/snapshot original da negociação é imutável; registre revisão auditável.';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 target_receipt:=NEW.recebimento_id;target_group:=NEW.grupo_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('neg-receipt:'||target_receipt::text,0));
 SELECT status,negociacao_numero INTO target_status,target_neg FROM fin_grupos_receber WHERE id=target_group;
 IF target_neg IS NOT NULL AND TG_OP='INSERT' AND NOT public.fn_negotiation_backend_context() THEN
  RAISE EXCEPTION 'Itens de negociação devem ser persistidos pelo backend após validação do job.';
 END IF;
 IF NOT public.fn_negotiation_backend_context() AND EXISTS(SELECT 1 FROM fin_residuos_negociacao z
   JOIN fin_recebimentos r ON r.gc_id=z.gc_recebimento_id WHERE r.id=target_receipt AND z.estado<>'disponivel') THEN
  RAISE EXCEPTION 'Residual indisponível não pode ser anexado diretamente pelo navegador.';
 END IF;
 IF target_status='cancelado' AND TG_OP='INSERT' THEN RAISE EXCEPTION 'Não adicionar itens a negociação cancelada.'; END IF;
 IF target_status<>'cancelado' AND EXISTS(SELECT 1 FROM fin_grupo_receber_itens i JOIN fin_grupos_receber g ON g.id=i.grupo_id
   WHERE i.recebimento_id=target_receipt AND i.grupo_id<>target_group AND g.status<>'cancelado') THEN
  RAISE EXCEPTION 'Recebimento já pertence a outro grupo ativo; vínculo duplicado impedido.';
 END IF;
 IF target_status<>'cancelado' AND EXISTS(SELECT 1 FROM fin_recebimentos r JOIN fin_grupos_receber g ON g.id=r.grupo_id
   WHERE r.id=target_receipt AND r.grupo_id<>target_group AND g.status<>'cancelado') THEN
  RAISE EXCEPTION 'Ponteiro do recebimento pertence a outro grupo ativo.';
 END IF;
 RETURN NEW;
END $$;
CREATE INDEX IF NOT EXISTS fin_grupo_receber_itens_recebimento_lookup ON public.fin_grupo_receber_itens(recebimento_id);
DROP TRIGGER IF EXISTS trg_guard_negotiated_item ON public.fin_grupo_receber_itens;
CREATE TRIGGER trg_guard_negotiated_item BEFORE INSERT OR UPDATE OR DELETE ON public.fin_grupo_receber_itens
 FOR EACH ROW EXECUTE FUNCTION public.fn_guard_negotiated_item();

CREATE OR REPLACE FUNCTION public.fn_guard_delete_grupo_receber()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.negociacao_numero IS NOT NULL OR coalesce(OLD.bloqueio_financeiro,false) OR OLD.status IN ('pago','pago_parcial')
   OR EXISTS(SELECT 1 FROM fin_grupo_receber_itens i JOIN fin_recebimentos r ON r.id=i.recebimento_id
      WHERE i.grupo_id=OLD.id AND (i.gc_baixado OR r.liquidado OR r.status='pago')) THEN
  RAISE EXCEPTION 'Histórico de negociação/pagamento não pode ser excluído. Solicite cancelamento auditável.';
 END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trg_guard_delete_grupo_receber ON public.fin_grupos_receber;
CREATE TRIGGER trg_guard_delete_grupo_receber BEFORE DELETE ON public.fin_grupos_receber
 FOR EACH ROW EXECUTE FUNCTION public.fn_guard_delete_grupo_receber();

CREATE OR REPLACE FUNCTION public.fn_guard_delete_recebimento()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.grupo_id IS NOT NULL OR EXISTS(SELECT 1 FROM fin_grupo_receber_itens i WHERE i.recebimento_id=OLD.id)
   OR EXISTS(SELECT 1 FROM fin_extrato_lancamentos a WHERE a.lancamento_id=OLD.id)
   OR EXISTS(SELECT 1 FROM fin_residuos_negociacao z WHERE z.gc_recebimento_id=OLD.gc_id)
   OR OLD.liquidado OR OLD.status='pago' THEN
  RAISE EXCEPTION 'Recebimento vinculado, residual ou liquidado preservado; exclusão física impedida.';
 END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trg_guard_delete_recebimento ON public.fin_recebimentos;
CREATE TRIGGER trg_guard_delete_recebimento BEFORE DELETE ON public.fin_recebimentos
 FOR EACH ROW EXECUTE FUNCTION public.fn_guard_delete_recebimento();

CREATE OR REPLACE FUNCTION public.fn_guard_recebimento_history()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE affected_group uuid;
BEGIN
 IF OLD.gc_id IS NOT NULL AND NEW.gc_id IS DISTINCT FROM OLD.gc_id THEN
  RAISE EXCEPTION 'ID GestãoClick persistente não pode ser trocado/removido por sincronização.';
 END IF;
 IF NEW.grupo_id IS DISTINCT FROM OLD.grupo_id THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('neg-receipt:'||OLD.id::text,0));
  IF EXISTS(SELECT 1 FROM fin_grupo_receber_itens i JOIN fin_grupos_receber g ON g.id=i.grupo_id
    WHERE i.recebimento_id=OLD.id AND g.status<>'cancelado' AND i.grupo_id IS DISTINCT FROM NEW.grupo_id) THEN
   RAISE EXCEPTION 'Sincronização não pode remover ou transferir vínculo ativo de negociação.';
  END IF;
 END IF;
 IF ROW(NEW.valor,NEW.cliente_gc_id,NEW.os_codigo) IS DISTINCT FROM ROW(OLD.valor,OLD.cliente_gc_id,OLD.os_codigo) THEN
  FOR affected_group IN SELECT DISTINCT i.grupo_id FROM fin_grupo_receber_itens i JOIN fin_grupos_receber g ON g.id=i.grupo_id
    WHERE i.recebimento_id=OLD.id AND g.negociacao_numero IS NOT NULL AND g.status<>'cancelado' LOOP
   UPDATE fin_grupos_receber SET integridade_status='pendente',bloqueio_financeiro=true,
    integridade_motivos=coalesce(integridade_motivos,'[]'::jsonb)||jsonb_build_array(jsonb_build_object(
      'codigo','titulo_alterado','gc_id',OLD.gc_id,'mensagem','Valor, cliente ou OS do título mudou; acordo original preservado.')),
    updated_at=now() WHERE id=affected_group;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard_recebimento_history ON public.fin_recebimentos;
CREATE TRIGGER trg_guard_recebimento_history BEFORE UPDATE ON public.fin_recebimentos
 FOR EACH ROW EXECUTE FUNCTION public.fn_guard_recebimento_history();

CREATE OR REPLACE FUNCTION public.fn_guard_grupo_integrity_write()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE facts jsonb; receipt_key uuid; expected_status text; backend boolean:=public.fn_negotiation_backend_context();
 finalizing boolean:=false;
BEGIN
 IF NEW.status IS NULL THEN RAISE EXCEPTION 'Grupo financeiro exige status explícito; valor nulo recusado.'; END IF;
 IF public.fn_negotiation_repair_context() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.negociacao_numero IS NOT NULL AND (NOT backend OR NEW.negociacao_job_id IS NULL
     OR NOT EXISTS(SELECT 1 FROM fin_negociacao_jobs j WHERE j.id=NEW.negociacao_job_id AND j.status='processando' AND j.execution_token IS NOT NULL)
     OR NEW.status NOT IN ('aberto','aguardando_pagamento')
     OR coalesce(NEW.integridade_status,'nao_verificado')='ok') THEN
   RAISE EXCEPTION 'Nova negociação inicia sem quitação e aguarda validação da composição pelo backend.';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.negociacao_numero IS NOT NULL AND ROW(NEW.negociacao_numero,NEW.valor_total,NEW.cliente_gc_id,NEW.os_codigos,NEW.negociacao_job_id)
     IS DISTINCT FROM ROW(OLD.negociacao_numero,OLD.valor_total,OLD.cliente_gc_id,OLD.os_codigos,OLD.negociacao_job_id) THEN
  RAISE EXCEPTION 'Número, valor original, cliente e OS do acordo exigem revisão auditada; sincronização não pode reescrevê-los.';
 END IF;
 finalizing:=backend AND NEW.negociacao_job_id IS NOT NULL AND OLD.negociacao_job_id=NEW.negociacao_job_id
   AND current_setting('wedo.negotiation_finalize_job',true)=NEW.negociacao_job_id::text
   AND EXISTS(SELECT 1 FROM fin_negociacao_jobs j WHERE j.id=NEW.negociacao_job_id AND j.status='processando'
     AND j.execution_token IS NOT NULL AND j.persisted_plan_hash IS NOT NULL
     AND coalesce((j.resultado->>'integrity_verified')::boolean,false)
     AND coalesce((j.resultado->>'success')::boolean,false)
     AND coalesce((j.resultado#>>'{summary,errors}')::int,1)=0);
 IF OLD.status='cancelado' AND NEW.status<>'cancelado' THEN
  FOR receipt_key IN SELECT recebimento_id FROM fin_grupo_receber_itens WHERE grupo_id=OLD.id ORDER BY recebimento_id LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('neg-receipt:'||receipt_key::text,0));
   IF EXISTS(SELECT 1 FROM fin_grupo_receber_itens i JOIN fin_grupos_receber g ON g.id=i.grupo_id
     WHERE i.recebimento_id=receipt_key AND i.grupo_id<>OLD.id AND g.status<>'cancelado') THEN
    RAISE EXCEPTION 'Reativação criaria segundo grupo ativo para o mesmo recebimento.';
   END IF;
  END LOOP;
 END IF;
 IF ((OLD.integridade_status='pendente' AND NEW.integridade_status<>'pendente')
    OR (coalesce(OLD.bloqueio_financeiro,false) AND NOT coalesce(NEW.bloqueio_financeiro,false))) AND NOT coalesce(finalizing,false) THEN
  RAISE EXCEPTION 'Pendência não pode ser liberada por sincronização; requer revisão explícita com evidências.';
 END IF;
 IF NEW.integridade_status='ok' AND OLD.integridade_status IS DISTINCT FROM 'ok' THEN
  facts:=public.fin_grupo_integrity_facts(OLD.id);
  IF NOT backend OR coalesce((facts->>'completo')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'Composição não conferida; não liberar integridade.'; END IF;
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND OLD.negociacao_numero IS NOT NULL AND NOT backend THEN
  RAISE EXCEPTION 'Status financeiro de negociação deve ser confirmado pelo backend.';
 END IF;
 IF OLD.negociacao_numero IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status
   AND NEW.status IN ('aberto','pago_parcial','pago') THEN
  facts:=public.fin_grupo_integrity_facts(OLD.id);
  expected_status:=CASE WHEN (facts->>'total')::int>0 AND (facts->>'total')::int=(facts->>'pagos')::int THEN 'pago'
    WHEN (facts->>'pagos')::int>0 THEN 'pago_parcial' ELSE 'aberto' END;
  IF coalesce(NEW.bloqueio_financeiro,false) OR NEW.integridade_status<>'ok'
    OR coalesce((facts->>'completo')::boolean,false) IS NOT TRUE OR NEW.status::text<>expected_status THEN
   RAISE EXCEPTION 'Transição financeira diverge da composição e quitação verificadas; operação impedida.';
  END IF;
 END IF;
 IF NEW.status='pago' AND NEW.status IS DISTINCT FROM OLD.status THEN
  facts:=public.fin_grupo_integrity_facts(OLD.id);
  IF coalesce(NEW.bloqueio_financeiro,false) OR NEW.integridade_status<>'ok'
    OR coalesce((facts->>'completo')::boolean,false) IS NOT TRUE
    OR (facts->>'total')::int<>(facts->>'pagos')::int THEN
   RAISE EXCEPTION 'Quitação integral exige composição íntegra e todos os títulos efetivamente quitados.';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard_grupo_integrity_write ON public.fin_grupos_receber;
CREATE TRIGGER trg_guard_grupo_integrity_write BEFORE INSERT OR UPDATE ON public.fin_grupos_receber
 FOR EACH ROW EXECUTE FUNCTION public.fn_guard_grupo_integrity_write();

CREATE OR REPLACE FUNCTION public.fn_residuos_estado_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE rec public.fin_recebimentos%ROWTYPE; has_active boolean:=false; releasing boolean;
BEGIN
 NEW.estado:=coalesce(NEW.estado,'pendente_vinculo');
 IF TG_OP='UPDATE' AND NOT public.fn_negotiation_repair_context() THEN
  IF OLD.gc_recebimento_id IS NOT NULL AND NEW.gc_recebimento_id IS DISTINCT FROM OLD.gc_recebimento_id THEN RAISE EXCEPTION 'ID GC original do residual preservado.'; END IF;
  IF ROW(NEW.negociacao_origem_numero,NEW.cliente_gc_id,NEW.valor_residual,NEW.os_codigos)
     IS DISTINCT FROM ROW(OLD.negociacao_origem_numero,OLD.cliente_gc_id,OLD.valor_residual,OLD.os_codigos) THEN
   RAISE EXCEPTION 'Origem, cliente, valor e OS históricos do residual não podem ser apagados ou reescritos.';
  END IF;
 END IF;
 SELECT * INTO rec FROM fin_recebimentos WHERE gc_id=NEW.gc_recebimento_id;
 IF FOUND THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('neg-receipt:'||rec.id::text,0));
  SELECT EXISTS(SELECT 1 FROM fin_grupo_receber_itens i JOIN fin_grupos_receber g ON g.id=i.grupo_id
    WHERE i.recebimento_id=rec.id AND g.status<>'cancelado') OR EXISTS(SELECT 1 FROM fin_grupos_receber g
    WHERE g.id=rec.grupo_id AND g.status<>'cancelado') INTO has_active;
 END IF;
 releasing:=TG_OP='UPDATE' AND OLD.estado='reservado' AND NEW.estado='disponivel'
   AND public.fn_negotiation_backend_context() AND current_setting('wedo.residual_release_authorized',true)='true';
 IF TG_OP='UPDATE' AND NEW.estado='disponivel' AND OLD.estado<>'disponivel'
   AND NOT public.fn_negotiation_repair_context() AND NOT coalesce(releasing,false) THEN
  RAISE EXCEPTION 'Residual indisponível exige liberação auditada; alteração direta recusada.';
 END IF;
 IF NEW.estado='disponivel' AND (has_active OR rec.liquidado OR rec.status='pago') THEN
  RAISE EXCEPTION 'Título pago ou alocado não pode voltar à seleção de resíduos.';
 END IF;
 IF NEW.estado='reservado' AND (has_active OR rec.liquidado OR rec.status='pago') THEN
  RAISE EXCEPTION 'Reserva recusada: título pago ou já alocado.';
 END IF;
 IF NEW.estado<>'em_revisao' AND (rec.liquidado OR rec.status='pago') THEN NEW.estado:='liquidado';
 ELSIF NEW.estado NOT IN ('em_revisao','liquidado') AND has_active THEN NEW.estado:='alocado';
 ELSIF NEW.estado='disponivel' AND (NEW.gc_recebimento_id IS NULL OR rec.id IS NULL) THEN NEW.estado:='pendente_vinculo'; END IF;
 NEW.utilizado:=NEW.estado<>'disponivel';
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_residuos_estado_guard ON public.fin_residuos_negociacao;
CREATE TRIGGER trg_residuos_estado_guard BEFORE INSERT OR UPDATE ON public.fin_residuos_negociacao
 FOR EACH ROW EXECUTE FUNCTION public.fn_residuos_estado_guard();

CREATE OR REPLACE FUNCTION public.fn_refresh_residual_receipt(p_recebimento_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rec public.fin_recebimentos%ROWTYPE; has_active boolean;
BEGIN
 SELECT * INTO rec FROM fin_recebimentos WHERE id=p_recebimento_id;
 IF NOT FOUND OR rec.gc_id IS NULL THEN RETURN; END IF;
 SELECT EXISTS(SELECT 1 FROM fin_grupo_receber_itens i JOIN fin_grupos_receber g ON g.id=i.grupo_id
   WHERE i.recebimento_id=rec.id AND g.status<>'cancelado') INTO has_active;
 UPDATE fin_residuos_negociacao SET estado=CASE WHEN rec.liquidado OR rec.status='pago' THEN 'liquidado' ELSE 'alocado' END,
   utilizado=true
 WHERE gc_recebimento_id=rec.gc_id AND estado NOT IN ('em_revisao','liquidado')
   AND (rec.liquidado OR rec.status='pago' OR has_active)
   AND (estado IS DISTINCT FROM CASE WHEN rec.liquidado OR rec.status='pago' THEN 'liquidado' ELSE 'alocado' END OR utilizado IS NOT TRUE);
 -- A cancelled/removed group or a later stale ERP sync never releases a residual.
END $$;
REVOKE ALL ON FUNCTION public.fn_refresh_residual_receipt(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_refresh_residual_receipt(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_sync_residual_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='fin_recebimentos' THEN PERFORM public.fn_refresh_residual_receipt(NEW.id);
 ELSE PERFORM public.fn_refresh_residual_receipt(NEW.recebimento_id); END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_sync_residual_receipt ON public.fin_recebimentos;
CREATE TRIGGER trg_sync_residual_receipt AFTER INSERT OR UPDATE OF liquidado,status,grupo_id ON public.fin_recebimentos
 FOR EACH ROW EXECUTE FUNCTION public.fn_sync_residual_receipt();
DROP TRIGGER IF EXISTS trg_sync_residual_receipt ON public.fin_grupo_receber_itens;
CREATE TRIGGER trg_sync_residual_receipt AFTER INSERT OR UPDATE OF grupo_id,recebimento_id ON public.fin_grupo_receber_itens
 FOR EACH ROW EXECUTE FUNCTION public.fn_sync_residual_receipt();

CREATE OR REPLACE FUNCTION public.fn_recheck_grupo_integrity_flag()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.integridade_status='ok' AND OLD.integridade_status IS DISTINCT FROM 'ok' THEN
  PERFORM public.fn_refresh_grupo_receber_integrity(NEW.id);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_recheck_grupo_integrity_flag ON public.fin_grupos_receber;
CREATE TRIGGER trg_recheck_grupo_integrity_flag AFTER UPDATE OF integridade_status ON public.fin_grupos_receber
 FOR EACH ROW EXECUTE FUNCTION public.fn_recheck_grupo_integrity_flag();

CREATE OR REPLACE FUNCTION public.fin_solicitar_cancelamento_negociacao(p_grupo_ids uuid[],p_motivo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE grp public.fin_grupos_receber%ROWTYPE; previous jsonb; affected uuid[]:='{}'; actor_id uuid:=auth.uid();
BEGIN
 IF actor_id IS NULL OR NOT public.has_financeiro_write(actor_id) THEN RAISE EXCEPTION 'Sem permissão financeira.'; END IF;
 IF cardinality(p_grupo_ids) IS NULL OR cardinality(p_grupo_ids)<1 OR cardinality(p_grupo_ids)>100
   OR length(trim(coalesce(p_motivo,'')))<10 THEN RAISE EXCEPTION 'Informe grupos e motivo detalhado com pelo menos10 caracteres.'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_grupo_ids) key WHERE key IS NULL OR NOT EXISTS(SELECT 1 FROM fin_grupos_receber g WHERE g.id=key AND g.negociacao_numero IS NOT NULL)) THEN
  RAISE EXCEPTION 'Há grupo inexistente ou sem negociação.';
 END IF;
 FOR grp IN SELECT * FROM fin_grupos_receber WHERE id=ANY(p_grupo_ids) ORDER BY id FOR UPDATE LOOP
  previous:=to_jsonb(grp);
  UPDATE fin_grupos_receber SET integridade_status='pendente',bloqueio_financeiro=true,
   integridade_motivos=coalesce(integridade_motivos,'[]'::jsonb)||jsonb_build_array(jsonb_build_object(
     'codigo','cancelamento_solicitado','mensagem',trim(p_motivo),'solicitado_por',actor_id,'solicitado_em',now())),updated_at=now()
  WHERE id=grp.id;
  INSERT INTO fin_audit_log(acao,ator,entidade_tipo,entidade_id,antes,depois,justificativa)
  SELECT 'negociacao_cancelamento_solicitado',actor_id::text,'fin_grupos_receber',g.id::text,previous,to_jsonb(g),trim(p_motivo)
  FROM fin_grupos_receber g WHERE g.id=grp.id;
  affected:=array_append(affected,grp.id);
 END LOOP;
 RETURN jsonb_build_object('solicitados',cardinality(affected),'grupo_ids',affected,'status','revisao_pendente');
END $$;
REVOKE ALL ON FUNCTION public.fin_solicitar_cancelamento_negociacao(uuid[],text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fin_solicitar_cancelamento_negociacao(uuid[],text) TO authenticated;

-- Only the enqueue/worker RPCs and service backend can mutate financial jobs.
REVOKE INSERT,UPDATE,DELETE ON public.fin_negociacao_jobs FROM PUBLIC,anon,authenticated;
DO $$ DECLARE policy_row record; BEGIN
 FOR policy_row IN SELECT polname FROM pg_policy WHERE polrelid='public.fin_negociacao_jobs'::regclass AND polcmd IN ('a','w','d','*') LOOP
  EXECUTE format('DROP POLICY %I ON public.fin_negociacao_jobs',policy_row.polname);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.fn_guard_negotiation_job_write()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT public.fn_negotiation_backend_context() THEN RAISE EXCEPTION 'Jobs de negociação só podem ser escritos pelo backend.'; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Jobs financeiros preservados para rastreabilidade; exclusão recusada.'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.payload,NEW.idempotency_key,NEW.created_by_user,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.payload,OLD.idempotency_key,OLD.created_by_user,OLD.created_at) THEN
  RAISE EXCEPTION 'Payload, chave idempotente e autoria do job são imutáveis.';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard_negotiation_job_write ON public.fin_negociacao_jobs;
CREATE TRIGGER trg_guard_negotiation_job_write BEFORE INSERT OR UPDATE OR DELETE ON public.fin_negociacao_jobs
 FOR EACH ROW EXECUTE FUNCTION public.fn_guard_negotiation_job_write();

-- Machine syncs must leave the same recoverable evidence as interactive changes.
CREATE OR REPLACE FUNCTION public.fn_audit_negotiation_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE before_row jsonb; after_row jsonb; reduced_before jsonb; reduced_after jsonb; entity_key text;
BEGIN
 IF TG_OP<>'INSERT' THEN before_row:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN after_row:=to_jsonb(NEW); END IF;
 reduced_before:=before_row-ARRAY['updated_at','last_synced_at','gc_payload_raw'];
 reduced_after:=after_row-ARRAY['updated_at','last_synced_at','gc_payload_raw'];
 IF TG_OP='UPDATE' AND reduced_before IS NOT DISTINCT FROM reduced_after THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='fin_recebimentos' AND coalesce(before_row->>'grupo_id',after_row->>'grupo_id') IS NULL
   AND NOT EXISTS(SELECT 1 FROM fin_residuos_negociacao z WHERE z.gc_recebimento_id=coalesce(after_row->>'gc_id',before_row->>'gc_id')) THEN
  RETURN coalesce(NEW,OLD);
 END IF;
 entity_key:=coalesce(after_row->>'id',before_row->>'id');
 INSERT INTO fin_audit_log(acao,ator,entidade_tipo,entidade_id,antes,depois,justificativa,evidencias)
 VALUES('negociacao_integridade_'||lower(TG_OP),coalesce(auth.uid()::text,auth.role(),session_user),TG_TABLE_NAME,entity_key,
   before_row,after_row,'Rastreabilidade automática de alteração de negociação, inclusive sincronizações.',
   jsonb_build_object('audit_repair_batch',current_setting('wedo.audit_repair_batch',true),'session_user',session_user));
 RETURN coalesce(NEW,OLD);
END $$;
DO $$ DECLARE table_key text; BEGIN
 FOREACH table_key IN ARRAY ARRAY['fin_grupos_receber','fin_grupo_receber_itens','fin_recebimentos','fin_residuos_negociacao','fin_negociacao_jobs'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_negotiation_integrity ON public.%I',table_key);
  EXECUTE format('CREATE TRIGGER trg_audit_negotiation_integrity AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_audit_negotiation_integrity()',table_key);
 END LOOP;
END $$;
COMMIT;
