-- A request owns its sources and installment numbers before any external write.
ALTER TABLE public.fin_negociacao_jobs
  ADD COLUMN IF NOT EXISTS created_by_user uuid,
  ADD COLUMN IF NOT EXISTS negociacao_numero integer,
  ADD COLUMN IF NOT EXISTS execution_state jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS execution_token uuid,
  ADD COLUMN IF NOT EXISTS payload_hash text,
  ADD COLUMN IF NOT EXISTS persisted_plan_hash text,
  ADD COLUMN IF NOT EXISTS plano jsonb;
ALTER TABLE public.fin_grupos_receber
  ADD COLUMN IF NOT EXISTS negociacao_job_id uuid REFERENCES public.fin_negociacao_jobs(id),
  ADD COLUMN IF NOT EXISTS parcela_numero integer;
ALTER TABLE public.fin_residuos_negociacao
  ADD COLUMN IF NOT EXISTS negociacao_origem_grupo_id uuid REFERENCES public.fin_grupos_receber(id);
CREATE UNIQUE INDEX IF NOT EXISTS fin_negociacao_job_parcela_unique
  ON public.fin_grupos_receber(negociacao_job_id, parcela_numero)
  WHERE negociacao_job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fin_negociacao_request_unique
  ON public.fin_negociacao_jobs(created_by_user, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND created_by_user IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.fin_negociacao_reservas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_key text NOT NULL,
  job_id uuid NOT NULL REFERENCES public.fin_negociacao_jobs(id),
  estado text NOT NULL DEFAULT 'reservado' CHECK (estado IN ('reservado','consumido','liberado')),
  cliente_gc_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_negociacao_origem_exclusiva
  ON public.fin_negociacao_reservas(origin_key) WHERE estado IN ('reservado','consumido');
ALTER TABLE public.fin_negociacao_reservas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fin_negociacao_reservas FROM anon, authenticated;
GRANT ALL ON public.fin_negociacao_reservas TO service_role;
GRANT SELECT ON public.fin_negociacao_reservas TO authenticated;
DROP POLICY IF EXISTS financeiro_read_reservas ON public.fin_negociacao_reservas;
CREATE POLICY financeiro_read_reservas ON public.fin_negociacao_reservas FOR SELECT TO authenticated
  USING (public.has_financeiro_write(auth.uid()));

CREATE OR REPLACE FUNCTION public.fin_enqueue_negotiation(p_payload jsonb,p_idempotency_key text,p_created_by uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE
  v_job public.fin_negociacao_jobs; v_payload jsonb; v_hash text; v_origin text;
  v_sources text[]; v_id uuid; v_num integer; v_res public.fin_residuos_negociacao;
  v_cliente text := p_payload->>'cliente_gc_id';
BEGIN
  IF NOT public.has_financeiro_write(p_created_by) THEN RAISE EXCEPTION 'Perfil sem permissão financeira' USING ERRCODE='42501'; END IF;
  IF length(coalesce(p_idempotency_key,'')) < 16 OR length(p_idempotency_key)>200 THEN RAISE EXCEPTION 'Chave de idempotência inválida'; END IF;
  IF coalesce(v_cliente,'')='' OR jsonb_typeof(p_payload)<>'object' THEN RAISE EXCEPTION 'Cliente e solicitação obrigatórios'; END IF;
  v_payload := p_payload - ARRAY['action','_job_id','_execution_token','_created_by','_gc_user','created_by','created_by_user','idempotency_key'];
  v_hash := md5(v_payload::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_created_by::text||':'||p_idempotency_key,0));
  SELECT * INTO v_job FROM fin_negociacao_jobs WHERE created_by_user=p_created_by AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_job.payload_hash IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'A mesma chave foi usada com dados diferentes' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('job_id',v_job.id,'status',v_job.status,'negociacao_numero',v_job.negociacao_numero,'reused',true);
  END IF;
  IF jsonb_typeof(coalesce(v_payload->'os_ids','[]'))<>'array' OR jsonb_typeof(coalesce(v_payload->'residual_ids','[]'))<>'array' THEN RAISE EXCEPTION 'Origens inválidas'; END IF;
  SELECT array_agg(source ORDER BY source) INTO v_sources FROM (
    SELECT 'os:'||value AS source FROM jsonb_array_elements_text(coalesce(v_payload->'os_ids','[]'))
    UNION ALL SELECT 'residual:'||value FROM jsonb_array_elements_text(coalesce(v_payload->'residual_ids','[]'))
  ) src;
  IF coalesce(cardinality(v_sources),0)=0 OR cardinality(v_sources)>200 THEN RAISE EXCEPTION 'Selecione de 1 a 200 origens'; END IF;
  IF cardinality(v_sources)<>(SELECT count(DISTINCT source) FROM unnest(v_sources) source) THEN RAISE EXCEPTION 'Origem repetida na solicitação'; END IF;
  FOREACH v_origin IN ARRAY v_sources LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_origin,0));
    IF EXISTS(SELECT 1 FROM fin_negociacao_reservas WHERE origin_key=v_origin AND estado IN ('reservado','consumido')) THEN
      RAISE EXCEPTION 'Origem % já reservada ou negociada; confira o acordo existente',v_origin USING ERRCODE='23505';
    END IF;
    IF v_origin LIKE 'residual:%' THEN
      SELECT * INTO v_res FROM fin_residuos_negociacao WHERE id=substring(v_origin FROM 10)::uuid FOR UPDATE;
      IF NOT FOUND OR v_res.cliente_gc_id IS DISTINCT FROM v_cliente OR v_res.utilizado IS TRUE
        OR v_res.estado IS DISTINCT FROM 'disponivel' OR v_res.valor_residual<=0 OR v_res.gc_recebimento_id IS NULL THEN
        RAISE EXCEPTION 'Saldo indisponível, sem título ou de outro cliente: %',v_origin;
      END IF;
      IF EXISTS(SELECT 1 FROM fin_recebimentos rec WHERE rec.gc_id=v_res.gc_recebimento_id
        AND (rec.liquidado IS TRUE OR rec.status IN ('pago','cancelado') OR rec.cliente_gc_id IS DISTINCT FROM v_cliente
          OR rec.grupo_id IS NOT NULL OR EXISTS(SELECT 1 FROM fin_grupo_receber_itens it WHERE it.recebimento_id=rec.id))) THEN
        RAISE EXCEPTION 'Título do saldo já pago, cancelado, alocado ou com cliente divergente';
      END IF;
    ELSIF substring(v_origin FROM 4) !~ '^[0-9]+$' THEN RAISE EXCEPTION 'ID da OS inválido';
    END IF;
  END LOOP;
  v_num := public.next_negociacao_number();
  INSERT INTO fin_negociacao_jobs(payload,status,progresso,created_by,created_by_user,idempotency_key,payload_hash,negociacao_numero,total_count)
  VALUES(v_payload,'pendente','Origens reservadas; aguardando execução',p_created_by::text,p_created_by,p_idempotency_key,v_hash,v_num,cardinality(v_sources)) RETURNING id INTO v_id;
  FOREACH v_origin IN ARRAY v_sources LOOP
    INSERT INTO fin_negociacao_reservas(origin_key,job_id,cliente_gc_id) VALUES(v_origin,v_id,v_cliente);
    IF v_origin LIKE 'residual:%' THEN UPDATE fin_residuos_negociacao SET estado='reservado',utilizado=true WHERE id=substring(v_origin FROM 10)::uuid; END IF;
  END LOOP;
  INSERT INTO fin_audit_log(acao,ator,entidade_tipo,entidade_id,depois,justificativa)
    VALUES('negotiation_reserved',p_created_by::text,'fin_negociacao_jobs',v_id::text,jsonb_build_object('origens',v_sources,'numero',v_num),'Solicitação idempotente e reserva atômica de origens');
  RETURN jsonb_build_object('job_id',v_id,'status','pendente','negociacao_numero',v_num,'reused',false);
END $fn$;

CREATE OR REPLACE FUNCTION public.fin_claim_negotiation_execution(p_job_id uuid,p_execution_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE v_claimed uuid;
BEGIN
  IF p_execution_token IS NULL THEN RETURN false; END IF;
  UPDATE fin_negociacao_jobs SET execution_token=p_execution_token,status='processando',iniciado_em=now(),
    tentativas=coalesce(tentativas,0)+1,progresso='Conferindo plano e títulos',updated_at=now()
  WHERE id=p_job_id AND status='pendente' AND execution_token IS NULL AND payload_hash IS NOT NULL
  RETURNING id INTO v_claimed;
  RETURN v_claimed IS NOT NULL;
END $fn$;

-- Remove unfenced overloads: all workers must prove their current ownership.
DROP FUNCTION IF EXISTS public.fin_persist_negotiation(uuid,jsonb);
DROP FUNCTION IF EXISTS public.fin_finalize_negotiation(uuid,jsonb);
CREATE OR REPLACE FUNCTION public.fin_persist_negotiation(p_job_id uuid,p_plan jsonb,p_execution_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE
  v_job public.fin_negociacao_jobs; v_origin jsonb; v_parcela jsonb; v_item jsonb; v_residual jsonb; v_raw jsonb;
  v_grupo uuid; v_rec uuid; v_existing public.fin_recebimentos; v_ids uuid[]:=ARRAY[]::uuid[];
  v_total bigint:=0; v_remaining bigint:=0; v_subtotal bigint; v_allocated bigint; v_expected bigint;
  v_num integer:=0; v_gc text; v_client text; v_hash text:=md5(p_plan::text); v_local_plan uuid; v_fp uuid; v_cc uuid;
BEGIN
  SELECT * INTO v_job FROM fin_negociacao_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR p_execution_token IS NULL OR v_job.execution_token IS DISTINCT FROM p_execution_token THEN RAISE EXCEPTION 'Execução não capturada ou token de executor expirado'; END IF;
  IF v_job.persisted_plan_hash IS NOT NULL THEN
    IF v_job.persisted_plan_hash<>v_hash THEN RAISE EXCEPTION 'Plano já persistido com outros dados'; END IF;
    SELECT array_agg(id ORDER BY parcela_numero) INTO v_ids FROM fin_grupos_receber WHERE negociacao_job_id=p_job_id;
    RETURN jsonb_build_object('grupo_ids',v_ids,'reused',true);
  END IF;
  IF v_job.status IS DISTINCT FROM 'processando' OR (p_plan->>'version')::int IS DISTINCT FROM 2 OR (p_plan->>'negociacao_numero')::int IS DISTINCT FROM v_job.negociacao_numero THEN RAISE EXCEPTION 'Plano incompatível com o job'; END IF;
  v_client:=v_job.payload->>'cliente_gc_id';
  IF p_plan->>'cliente_gc_id' IS DISTINCT FROM v_client THEN RAISE EXCEPTION 'Cliente do plano diverge do pedido'; END IF;
  IF jsonb_typeof(p_plan->'origins') IS DISTINCT FROM 'array' OR jsonb_typeof(p_plan->'parcelas') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_plan->'residuos') IS DISTINCT FROM 'array' OR jsonb_typeof(p_plan->'consumed_residual_ids') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_plan->'parcelas')<1 THEN RAISE EXCEPTION 'Plano incompleto'; END IF;
  IF ARRAY(SELECT value FROM jsonb_array_elements_text(p_plan->'consumed_residual_ids') ORDER BY value)
    IS DISTINCT FROM ARRAY(SELECT substring(origin_key FROM 10) FROM fin_negociacao_reservas WHERE job_id=p_job_id AND estado='reservado' AND origin_key LIKE 'residual:%' ORDER BY origin_key)
    THEN RAISE EXCEPTION 'Saldos consumidos divergem das reservas'; END IF;
  IF jsonb_array_length(p_plan->'origins')<>(SELECT count(*) FROM fin_negociacao_reservas WHERE job_id=p_job_id AND estado='reservado') THEN RAISE EXCEPTION 'Reserva incompleta'; END IF;
  IF (SELECT count(DISTINCT o->>'origin_key') FROM jsonb_array_elements(p_plan->'origins') o)<>jsonb_array_length(p_plan->'origins') THEN RAISE EXCEPTION 'Origem duplicada'; END IF;
  FOR v_origin IN SELECT value FROM jsonb_array_elements(p_plan->'origins') LOOP
    IF NOT EXISTS(SELECT 1 FROM fin_negociacao_reservas WHERE job_id=p_job_id AND origin_key=v_origin->>'origin_key' AND estado='reservado' AND cliente_gc_id=v_client) THEN RAISE EXCEPTION 'Origem não reservada'; END IF;
    v_expected:=(v_origin->>'available_cents')::bigint;
    IF v_origin->>'origin_key' LIKE 'residual:%' AND NOT EXISTS(
      SELECT 1 FROM fin_residuos_negociacao z WHERE z.id=substring(v_origin->>'origin_key' FROM 10)::uuid
        AND round(z.valor_residual*100)::bigint=v_expected AND z.cliente_gc_id=v_client AND z.estado='reservado'
    ) THEN RAISE EXCEPTION 'Saldo residual reservado diverge do valor original'; END IF;
    SELECT coalesce(sum((it->>'valor_cents')::bigint),0) INTO v_allocated FROM jsonb_array_elements(p_plan->'parcelas') pa CROSS JOIN LATERAL jsonb_array_elements(pa->'items') it WHERE it->>'origin_key'=v_origin->>'origin_key';
    SELECT v_allocated+coalesce(sum((rs->>'valor_cents')::bigint),0) INTO v_allocated FROM jsonb_array_elements(p_plan->'residuos') rs WHERE rs->>'origin_key'=v_origin->>'origin_key';
    IF v_expected IS NULL OR v_expected<=0 OR v_allocated IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Conservação de saldo falhou para %',v_origin->>'origin_key'; END IF;
  END LOOP;
  IF EXISTS(SELECT gc_id FROM (
    SELECT it->>'gc_id' gc_id FROM jsonb_array_elements(p_plan->'parcelas') pa CROSS JOIN LATERAL jsonb_array_elements(pa->'items') it
    UNION ALL SELECT rs->>'gc_id' FROM jsonb_array_elements(p_plan->'residuos') rs
  ) ids GROUP BY gc_id HAVING gc_id IS NULL OR count(*)>1) THEN RAISE EXCEPTION 'Título ausente ou reutilizado em duas alocações'; END IF;
  FOR v_parcela IN SELECT value FROM jsonb_array_elements(p_plan->'parcelas') LOOP
    v_num:=v_num+1;
    IF (v_parcela->>'numero')::int IS DISTINCT FROM v_num OR coalesce((v_parcela->>'valor_cents')::bigint,0)<=0 OR jsonb_typeof(v_parcela->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(v_parcela->'items')<1 THEN RAISE EXCEPTION 'Parcela inválida ou sem itens'; END IF;
    IF coalesce(v_parcela->>'data_vencimento','')='' OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_parcela->'items') item_row WHERE coalesce(item_row->>'os_codigo','')='') THEN RAISE EXCEPTION 'Parcela sem vencimento ou referência da OS'; END IF;
    SELECT coalesce(sum((it->>'valor_cents')::bigint),0) INTO v_subtotal FROM jsonb_array_elements(v_parcela->'items') it;
    IF v_subtotal<>(v_parcela->>'valor_cents')::bigint THEN RAISE EXCEPTION 'Valor da parcela não fecha'; END IF;
    v_total:=v_total+v_subtotal;
  END LOOP;
  SELECT coalesce(sum((rs->>'valor_cents')::bigint),0) INTO v_remaining FROM jsonb_array_elements(p_plan->'residuos') rs;
  IF v_total IS DISTINCT FROM (p_plan->>'negotiated_cents')::bigint OR v_remaining IS DISTINCT FROM (p_plan->>'remaining_cents')::bigint
    OR v_total+v_remaining IS DISTINCT FROM (p_plan->>'total_original_cents')::bigint THEN RAISE EXCEPTION 'Total do acordo não fecha'; END IF;
  -- Validate every identity and amount before changing any local financial row.
  FOR v_item IN
    SELECT it||jsonb_build_object('_expected_due',pa->>'data_vencimento') FROM jsonb_array_elements(p_plan->'parcelas') pa CROSS JOIN LATERAL jsonb_array_elements(pa->'items') it
    UNION ALL SELECT rs||jsonb_build_object('_expected_due',rs->>'data_vencimento') FROM jsonb_array_elements(p_plan->'residuos') rs
  LOOP
    v_raw:=v_item->'recebimento'; v_gc:=v_item->>'gc_id';
    IF coalesce((v_item->>'valor_cents')::bigint,0)<=0 OR coalesce(v_gc,'')='' OR v_gc IS DISTINCT FROM v_raw->>'id' OR v_raw->>'cliente_id' IS DISTINCT FROM v_client
      OR round(coalesce(v_raw->>'valor_total',v_raw->>'valor')::numeric*100) IS DISTINCT FROM (v_item->>'valor_cents')::bigint
      OR coalesce(v_raw->>'liquidado','') NOT IN ('0','false')
      OR nullif(v_item->>'_expected_due','') IS NULL
      OR nullif(v_raw->>'data_vencimento','')::date IS DISTINCT FROM (v_item->>'_expected_due')::date
      OR NOT EXISTS(SELECT 1 FROM fin_negociacao_reservas WHERE job_id=p_job_id AND origin_key=v_item->>'origin_key' AND estado='reservado') THEN RAISE EXCEPTION 'Identidade, cliente, saldo ou liquidação inválida no título %',v_gc; END IF;
    SELECT * INTO v_existing FROM fin_recebimentos WHERE gc_id=v_gc FOR UPDATE;
    IF FOUND AND (v_existing.cliente_gc_id IS DISTINCT FROM v_client OR v_existing.liquidado IS TRUE OR v_existing.status IN ('pago','cancelado') OR v_existing.grupo_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM fin_grupo_receber_itens WHERE recebimento_id=v_existing.id)) THEN RAISE EXCEPTION 'Título local % mudou ou já pertence a acordo',v_gc; END IF;
  END LOOP;
  FOR v_parcela IN SELECT value FROM jsonb_array_elements(p_plan->'parcelas') LOOP
    INSERT INTO fin_grupos_receber(nome,cliente_gc_id,nome_cliente,valor_total,status,data_vencimento,negociacao_numero,
      negociacao_job_id,parcela_numero,os_codigos,itens_total,integridade_status,bloqueio_financeiro,integridade_motivos,created_by,observacao)
    VALUES('Negociação #'||v_job.negociacao_numero||' — Parcela '||(v_parcela->>'numero'),v_client,p_plan->>'nome_cliente',
      (v_parcela->>'valor_cents')::numeric/100,'aberto',(v_parcela->>'data_vencimento')::date,v_job.negociacao_numero,p_job_id,(v_parcela->>'numero')::int,
      ARRAY(SELECT DISTINCT it->>'os_codigo' FROM jsonb_array_elements(v_parcela->'items') it WHERE coalesce(it->>'os_codigo','')<>''),
      jsonb_array_length(v_parcela->'items'),'pendente',true,'["Aguardando verificação final da execução"]',v_job.created_by_user::text,
      'Plano v2 preservado no job '||p_job_id::text) RETURNING id INTO v_grupo;
    v_ids:=array_append(v_ids,v_grupo);
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_parcela->'items') LOOP
      v_raw:=v_item->'recebimento'; v_gc:=v_item->>'gc_id';
      SELECT id INTO v_local_plan FROM fin_plano_contas WHERE gc_id=v_raw->>'plano_contas_id' LIMIT 1;
      SELECT id INTO v_fp FROM fin_formas_pagamento WHERE gc_id=v_raw->>'forma_pagamento_id' LIMIT 1;
      SELECT id INTO v_cc FROM fin_centros_custo WHERE codigo=v_raw->>'centro_custo_id' LIMIT 1;
      INSERT INTO fin_recebimentos(gc_id,gc_codigo,descricao,os_codigo,tipo,origem,valor,cliente_gc_id,nome_cliente,data_vencimento,
        data_competencia,liquidado,status,gc_payload_raw,plano_contas_id,forma_pagamento_id,centro_custo_id,last_synced_at)
      VALUES(v_gc,v_raw->>'codigo',coalesce(v_raw->>'descricao','Negociação'),v_item->>'os_codigo','os','gc_os',
        (v_item->>'valor_cents')::numeric/100,v_client,p_plan->>'nome_cliente',(v_parcela->>'data_vencimento')::date,
        nullif(v_raw->>'data_competencia','')::date,false,'pendente',v_raw,v_local_plan,v_fp,v_cc,now())
      ON CONFLICT(gc_id) DO UPDATE SET valor=excluded.valor,data_vencimento=excluded.data_vencimento,gc_payload_raw=excluded.gc_payload_raw,last_synced_at=now()
      RETURNING id INTO v_rec;
      INSERT INTO fin_grupo_receber_itens(grupo_id,recebimento_id,valor,snapshot_valor,snapshot_data,os_codigo_original,gc_baixado)
        VALUES(v_grupo,v_rec,(v_item->>'valor_cents')::numeric/100,(v_item->>'valor_cents')::numeric/100,(v_parcela->>'data_vencimento')::date,v_item->>'os_codigo',false);
      UPDATE fin_recebimentos SET grupo_id=v_grupo WHERE id=v_rec;
    END LOOP;
  END LOOP;
  FOR v_residual IN SELECT value FROM jsonb_array_elements(p_plan->'residuos') LOOP
    v_raw:=v_residual->'recebimento'; v_gc:=v_residual->>'gc_id';
    INSERT INTO fin_recebimentos(gc_id,gc_codigo,descricao,tipo,origem,valor,cliente_gc_id,nome_cliente,data_vencimento,data_competencia,liquidado,status,gc_payload_raw,last_synced_at)
    VALUES(v_gc,v_raw->>'codigo',coalesce(v_raw->>'descricao','Saldo de negociação'),'os','gc_os',(v_residual->>'valor_cents')::numeric/100,
      v_client,p_plan->>'nome_cliente',(v_residual->>'data_vencimento')::date,nullif(v_raw->>'data_competencia','')::date,false,'pendente',v_raw,now())
    ON CONFLICT(gc_id) DO UPDATE SET valor=excluded.valor,data_vencimento=excluded.data_vencimento,gc_payload_raw=excluded.gc_payload_raw,last_synced_at=now();
    INSERT INTO fin_residuos_negociacao(cliente_gc_id,nome_cliente,negociacao_origem_numero,negociacao_origem_grupo_id,os_codigos,valor_residual,gc_recebimento_id,utilizado,estado)
    VALUES(v_client,p_plan->>'nome_cliente',v_job.negociacao_numero,v_ids[1],ARRAY(SELECT jsonb_array_elements_text(v_residual->'os_codigos')),
      (v_residual->>'valor_cents')::numeric/100,v_gc,true,'reservado');
  END LOOP;
  UPDATE fin_residuos_negociacao SET estado='alocado',utilizado=true,utilizado_em=coalesce(utilizado_em,now())
    WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(p_plan->'consumed_residual_ids'))
      AND EXISTS(SELECT 1 FROM fin_negociacao_reservas r WHERE r.job_id=p_job_id AND r.origin_key='residual:'||fin_residuos_negociacao.id::text AND r.estado='reservado');
  UPDATE fin_negociacao_jobs SET plano=p_plan,persisted_plan_hash=v_hash,updated_at=now() WHERE id=p_job_id;
  INSERT INTO fin_audit_log(acao,ator,entidade_tipo,entidade_id,depois,justificativa)
    VALUES('negotiation_plan_persisted',v_job.created_by_user::text,'fin_negociacao_jobs',p_job_id::text,p_plan,'Títulos verificados e composição persistidos em uma única transação');
  RETURN jsonb_build_object('grupo_ids',v_ids,'reused',false);
END $fn$;

CREATE OR REPLACE FUNCTION public.fin_finalize_negotiation(p_job_id uuid,p_result jsonb,p_execution_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE v_job public.fin_negociacao_jobs; v_complete boolean; v_count int;
BEGIN
  SELECT * INTO v_job FROM fin_negociacao_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job não encontrado'; END IF;
  IF p_execution_token IS NULL OR v_job.execution_token IS DISTINCT FROM p_execution_token THEN RAISE EXCEPTION 'Token de executor expirado ou ausente'; END IF;
  IF v_job.status='concluido' THEN RETURN jsonb_build_object('success',true,'reused',true); END IF;
  IF v_job.status IS DISTINCT FROM 'processando' OR v_job.execution_token IS NULL THEN RAISE EXCEPTION 'Finalização exige execução capturada em processamento'; END IF;
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Resultado de execução inválido'; END IF;
  v_complete := coalesce((p_result->>'success')::boolean,false) AND coalesce((p_result->>'integrity_verified')::boolean,false)
    AND coalesce((p_result#>>'{summary,errors}')::int,1)=0 AND v_job.persisted_plan_hash IS NOT NULL;
  IF v_complete THEN
    SELECT count(*) INTO v_count FROM fin_grupos_receber WHERE negociacao_job_id=p_job_id;
    v_complete:=v_count=jsonb_array_length(v_job.plano->'parcelas') AND v_count>0 AND NOT EXISTS(
      SELECT 1 FROM fin_grupos_receber g WHERE g.negociacao_job_id=p_job_id AND
        (g.valor_total IS DISTINCT FROM (SELECT sum(i.valor) FROM fin_grupo_receber_itens i WHERE i.grupo_id=g.id)
          OR g.itens_total<>(SELECT count(*) FROM fin_grupo_receber_itens i WHERE i.grupo_id=g.id)
          OR EXISTS(SELECT 1 FROM fin_grupo_receber_itens i JOIN fin_recebimentos r ON r.id=i.recebimento_id WHERE i.grupo_id=g.id
            AND (r.grupo_id IS DISTINCT FROM g.id OR r.cliente_gc_id IS DISTINCT FROM g.cliente_gc_id OR r.valor IS DISTINCT FROM i.valor))));
  END IF;
  IF v_complete THEN
    UPDATE fin_negociacao_jobs SET resultado=p_result WHERE id=p_job_id;
    PERFORM set_config('wedo.negotiation_finalize_job',p_job_id::text,true);
    UPDATE fin_grupos_receber SET integridade_status='ok',bloqueio_financeiro=false,integridade_motivos='[]',integridade_verificado_em=now() WHERE negociacao_job_id=p_job_id;
    PERFORM set_config('wedo.residual_release_authorized','true',true);
    UPDATE fin_residuos_negociacao z SET estado='disponivel',utilizado=false
      WHERE z.estado='reservado' AND z.negociacao_origem_grupo_id IN (SELECT g.id FROM fin_grupos_receber g WHERE g.negociacao_job_id=p_job_id);
    PERFORM set_config('wedo.residual_release_authorized','',true);
    UPDATE fin_negociacao_reservas SET estado='consumido',updated_at=now() WHERE job_id=p_job_id AND estado='reservado';
  ELSE
    UPDATE fin_grupos_receber SET integridade_status='pendente',bloqueio_financeiro=true,
      integridade_motivos=jsonb_build_array(coalesce(p_result->>'error','Execução incompleta; conferir etapas e títulos')) WHERE negociacao_job_id=p_job_id;
  END IF;
  UPDATE fin_negociacao_jobs SET status=CASE WHEN v_complete THEN 'concluido' ELSE 'erro' END,resultado=p_result,
    ok_count=coalesce((p_result#>>'{summary,ok}')::int,0),erro_count=CASE WHEN v_complete THEN 0 ELSE greatest(1,coalesce((p_result#>>'{summary,errors}')::int,1)) END,
    erro_msg=CASE WHEN v_complete THEN NULL ELSE coalesce(p_result->>'error','Execução pendente de conferência') END,
    progresso=CASE WHEN v_complete THEN 'Negociação conferida e concluída' ELSE 'Pendência de execução; origens continuam reservadas' END,
    finalizado_em=now(),updated_at=now() WHERE id=p_job_id;
  INSERT INTO fin_audit_log(acao,ator,entidade_tipo,entidade_id,depois,justificativa)
    VALUES('negotiation_execution_result',coalesce(v_job.created_by_user::text,'backend'),'fin_negociacao_jobs',p_job_id::text,p_result,
      CASE WHEN v_complete THEN 'Composição verificada antes da conclusão' ELSE 'Falha não libera saldo nem declara sucesso' END);
  RETURN jsonb_build_object('success',v_complete,'status',CASE WHEN v_complete THEN 'concluido' ELSE 'erro' END);
END $fn$;

CREATE OR REPLACE FUNCTION public.fin_resume_negotiation(p_job_id uuid,p_created_by uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE v_job public.fin_negociacao_jobs; v_before jsonb; v_sources text[];
BEGIN
  IF NOT coalesce(public.has_financeiro_write(p_created_by),false) THEN RAISE EXCEPTION 'Perfil sem permissão financeira' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_job FROM fin_negociacao_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job não encontrado'; END IF;
  IF v_job.status IS DISTINCT FROM 'erro' THEN RAISE EXCEPTION 'Somente execução em erro pode ser retomada'; END IF;
  SELECT array_agg(source ORDER BY source) INTO v_sources FROM (
    SELECT 'os:'||value AS source FROM jsonb_array_elements_text(coalesce(v_job.payload->'os_ids','[]'))
    UNION ALL SELECT 'residual:'||value FROM jsonb_array_elements_text(coalesce(v_job.payload->'residual_ids','[]'))
  ) original_sources;
  IF coalesce(cardinality(v_sources),0)=0 OR v_sources IS DISTINCT FROM ARRAY(
    SELECT origin_key FROM fin_negociacao_reservas WHERE job_id=p_job_id AND estado='reservado' ORDER BY origin_key
  ) THEN RAISE EXCEPTION 'Origens não estão integralmente reservadas; revisão necessária antes de retomar'; END IF;
  IF EXISTS(SELECT 1 FROM fin_grupos_receber g WHERE g.negociacao_job_id=p_job_id AND (
    g.status NOT IN ('aberto','aguardando_pagamento')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(g.integridade_motivos,'[]')) reason
      WHERE reason->>'codigo'='cancelamento_solicitado')
    OR coalesce((public.fin_grupo_integrity_facts(g.id)->>'completo')::boolean,false) IS NOT TRUE
    OR EXISTS(SELECT 1 FROM fin_grupo_receber_itens i JOIN fin_recebimentos r ON r.id=i.recebimento_id
      WHERE i.grupo_id=g.id AND (r.liquidado OR r.status IN ('pago','cancelado')
       OR r.valor IS DISTINCT FROM i.snapshot_valor OR r.grupo_id IS DISTINCT FROM g.id
       OR EXISTS(SELECT 1 FROM fin_extrato_lancamentos a WHERE a.lancamento_id=r.id)))
  )) THEN RAISE EXCEPTION 'Acordo teve alteração financeira ou solicitação de cancelamento posterior; retomar está bloqueado'; END IF;
  IF EXISTS(SELECT 1 FROM fin_residuos_negociacao z JOIN fin_grupos_receber g ON g.id=z.negociacao_origem_grupo_id
    LEFT JOIN fin_recebimentos r ON r.gc_id=z.gc_recebimento_id WHERE g.negociacao_job_id=p_job_id AND (
      z.estado IS DISTINCT FROM 'reservado' OR r.id IS NULL OR r.liquidado OR r.status IN ('pago','cancelado')
      OR r.valor IS DISTINCT FROM z.valor_residual OR r.cliente_gc_id IS DISTINCT FROM z.cliente_gc_id
      OR r.grupo_id IS NOT NULL OR EXISTS(SELECT 1 FROM fin_extrato_lancamentos a WHERE a.lancamento_id=r.id)
  )) THEN RAISE EXCEPTION 'Novo saldo do job sofreu movimentação posterior; retomar está bloqueado'; END IF;
  v_before:=to_jsonb(v_job);
  UPDATE fin_negociacao_jobs SET status='pendente',execution_token=NULL,iniciado_em=NULL,finalizado_em=NULL,
    erro_msg=NULL,progresso='Retomada autorizada; conferir etapas existentes antes de continuar',updated_at=now()
  WHERE id=p_job_id;
  INSERT INTO fin_audit_log(acao,ator,entidade_tipo,entidade_id,antes,depois,justificativa)
  SELECT 'negotiation_resume_requested',p_created_by::text,'fin_negociacao_jobs',j.id::text,v_before,to_jsonb(j),
    'Retomada explícita preserva número, payload, plano, evidências e reservas; efeitos externos precisam ser conferidos antes de nova tentativa.'
  FROM fin_negociacao_jobs j WHERE j.id=p_job_id;
  RETURN jsonb_build_object('job_id',p_job_id,'status','pendente','negociacao_numero',v_job.negociacao_numero);
END $fn$;

REVOKE ALL ON FUNCTION public.fin_enqueue_negotiation(jsonb,text,uuid),public.fin_claim_negotiation_execution(uuid,uuid),
 public.fin_persist_negotiation(uuid,jsonb,uuid),public.fin_finalize_negotiation(uuid,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fin_enqueue_negotiation(jsonb,text,uuid),public.fin_claim_negotiation_execution(uuid,uuid),
 public.fin_persist_negotiation(uuid,jsonb,uuid),public.fin_finalize_negotiation(uuid,jsonb,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fin_resume_negotiation(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fin_resume_negotiation(uuid,uuid) TO service_role;
