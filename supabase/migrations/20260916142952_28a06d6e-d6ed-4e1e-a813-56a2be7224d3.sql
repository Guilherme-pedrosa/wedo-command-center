CREATE OR REPLACE FUNCTION public.fin_enqueue_negotiation(p_payload jsonb, p_idempotency_key text, p_created_by uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_job public.fin_negociacao_jobs; v_payload jsonb; v_hash text; v_origin text;
  v_sources text[]; v_id uuid; v_num integer; v_res public.fin_residuos_negociacao;
  v_jobs uuid[];
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

  -- Recovery: the very same request from the same user, whose origins are still reserved by an
  -- unfinished job, returns that job instead of failing. Never creates a second negotiation.
  SELECT array_agg(DISTINCT r.job_id) INTO v_jobs FROM fin_negociacao_reservas r
    WHERE r.origin_key = ANY(v_sources) AND r.estado IN ('reservado','consumido');
  IF coalesce(cardinality(v_jobs),0)=1 THEN
    SELECT * INTO v_job FROM fin_negociacao_jobs WHERE id=v_jobs[1] FOR UPDATE;
    IF FOUND AND v_job.created_by_user = p_created_by AND v_job.payload_hash = v_hash
      AND v_job.status IN ('pendente','processando','erro')
      AND (SELECT count(*) FROM fin_negociacao_reservas r WHERE r.job_id=v_job.id AND r.estado='reservado') = cardinality(v_sources)
      AND (SELECT count(*) FROM fin_negociacao_reservas r WHERE r.job_id=v_job.id AND r.estado='reservado' AND r.origin_key = ANY(v_sources)) = cardinality(v_sources)
    THEN
      INSERT INTO fin_audit_log(acao,ator,entidade_tipo,entidade_id,depois,justificativa)
        VALUES('negotiation_request_recovered',p_created_by::text,'fin_negociacao_jobs',v_job.id::text,
          jsonb_build_object('origens',v_sources,'numero',v_job.negociacao_numero,'status',v_job.status),
          'Mesma solicitação reencaminhada; job existente devolvido sem nova reserva');
      RETURN jsonb_build_object('job_id',v_job.id,'status',v_job.status,'negociacao_numero',v_job.negociacao_numero,'reused',true,'recovered',true);
    END IF;
  END IF;

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
END $function$;