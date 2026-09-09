-- Whole-title grouping is atomic. Partial titles belong to the audited executor.
CREATE OR REPLACE FUNCTION public.fin_create_receivable_group(
  p_id uuid, p_nome text, p_observacao text, p_receipt_ids uuid[],
  p_data_vencimento date, p_expected_values jsonb, p_check_only boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE
  actor uuid:=auth.uid(); rec public.fin_recebimentos; grp public.fin_grupos_receber;
  receipt_id uuid; client_id text; client_name text; initialized boolean:=false;
  total numeric:=0; ids uuid[]; count_items integer:=0;
BEGIN
  IF actor IS NULL OR NOT public.has_financeiro_write(actor) THEN
    RAISE EXCEPTION 'Perfil sem permissão financeira' USING ERRCODE='42501';
  END IF;
  IF p_id IS NULL OR length(trim(coalesce(p_nome,'')))=0 OR coalesce(cardinality(p_receipt_ids),0) NOT BETWEEN 1 AND 100
    OR jsonb_typeof(p_expected_values) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Grupo ou seleção inválida'; END IF;
  SELECT array_agg(DISTINCT value ORDER BY value) INTO ids FROM unnest(p_receipt_ids) value;
  IF cardinality(ids)<>cardinality(p_receipt_ids) OR array_position(ids,NULL) IS NOT NULL THEN RAISE EXCEPTION 'Títulos repetidos ou ausentes'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('create-group:'||p_id::text,0));
  SELECT * INTO grp FROM fin_grupos_receber WHERE id=p_id FOR UPDATE;
  IF FOUND THEN
    IF grp.created_by IS DISTINCT FROM actor::text OR grp.nome IS DISTINCT FROM trim(p_nome)
      OR grp.data_vencimento IS DISTINCT FROM p_data_vencimento OR grp.observacao IS DISTINCT FROM nullif(p_observacao,'')
      OR ids IS DISTINCT FROM ARRAY(SELECT recebimento_id FROM fin_grupo_receber_itens WHERE grupo_id=p_id ORDER BY recebimento_id)
      OR EXISTS(SELECT 1 FROM fin_grupo_receber_itens i WHERE i.grupo_id=p_id AND i.valor IS DISTINCT FROM (p_expected_values->>i.recebimento_id::text)::numeric)
    THEN RAISE EXCEPTION 'Identidade do grupo já usada com outros dados'; END IF;
    RETURN jsonb_build_object('id',p_id,'reused',true);
  END IF;
  FOREACH receipt_id IN ARRAY ids LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('neg-receipt:'||receipt_id::text,0));
    SELECT * INTO rec FROM fin_recebimentos WHERE id=receipt_id FOR UPDATE;
    IF NOT FOUND OR rec.valor<=0 OR rec.liquidado OR rec.status IN ('pago','cancelado') OR rec.grupo_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM fin_grupo_receber_itens i JOIN fin_grupos_receber g ON g.id=i.grupo_id WHERE i.recebimento_id=receipt_id AND g.status<>'cancelado')
    THEN RAISE EXCEPTION 'Título inexistente, pago, cancelado ou já agrupado'; END IF;
    IF rec.valor IS DISTINCT FROM (p_expected_values->>receipt_id::text)::numeric THEN RAISE EXCEPTION 'Valor mudou; agrupamento parcial exige negociação conferida no GC'; END IF;
    IF rec.gc_id IS NOT NULL AND rec.cliente_gc_id IS NULL THEN RAISE EXCEPTION 'Título GC sem identidade do cliente'; END IF;
    IF EXISTS(SELECT 1 FROM fin_residuos_negociacao z WHERE z.gc_recebimento_id=rec.gc_id AND z.estado<>'disponivel') THEN
      RAISE EXCEPTION 'Título de saldo reservado, alocado ou em revisão';
    END IF;
    IF EXISTS(SELECT 1 FROM fin_negociacao_reservas r WHERE r.estado IN ('reservado','consumido') AND
      (r.origin_key IN (SELECT 'residual:'||z.id::text FROM fin_residuos_negociacao z WHERE z.gc_recebimento_id=rec.gc_id)
       OR r.origin_key IN (SELECT 'os:'||o.os_id FROM os_index o WHERE o.os_codigo=rec.os_codigo))) THEN
      RAISE EXCEPTION 'Título pertence a origem reservada em negociação';
    END IF;
    IF NOT initialized THEN client_id:=rec.cliente_gc_id; client_name:=rec.nome_cliente; initialized:=true;
    ELSIF rec.cliente_gc_id IS DISTINCT FROM client_id OR (client_id IS NULL AND rec.nome_cliente IS DISTINCT FROM client_name) THEN
      RAISE EXCEPTION 'Grupo contém clientes diferentes';
    END IF;
    total:=total+rec.valor; count_items:=count_items+1;
  END LOOP;
  IF p_check_only THEN RETURN NULL; END IF;
  INSERT INTO fin_grupos_receber(id,nome,cliente_gc_id,nome_cliente,valor_total,status,data_vencimento,observacao,itens_total,created_by,os_codigos)
    VALUES(p_id,trim(p_nome),client_id,client_name,total,'aberto',p_data_vencimento,nullif(p_observacao,''),count_items,actor::text,
      ARRAY(SELECT DISTINCT os_codigo FROM fin_recebimentos WHERE id=ANY(ids) AND os_codigo IS NOT NULL ORDER BY os_codigo));
  INSERT INTO fin_grupo_receber_itens(grupo_id,recebimento_id,valor,os_codigo_original,snapshot_valor,snapshot_data)
    SELECT p_id,id,valor,os_codigo,valor,data_vencimento FROM fin_recebimentos WHERE id=ANY(ids);
  UPDATE fin_recebimentos SET grupo_id=p_id,data_vencimento=coalesce(p_data_vencimento,data_vencimento) WHERE id=ANY(ids);
  IF NOT coalesce((public.fin_grupo_integrity_facts(p_id)->>'completo')::boolean,false) THEN RAISE EXCEPTION 'Composição não confirmou o grupo'; END IF;
  INSERT INTO fin_audit_log(acao,ator,entidade_tipo,entidade_id,depois,justificativa)
    VALUES('receivable_group_created',actor::text,'fin_grupos_receber',p_id::text,
      jsonb_build_object('receipt_ids',ids,'valor_total',total,'data_vencimento',p_data_vencimento),
      'Grupo integral e vínculos persistidos em transação única; conferência de GC executada pelo fluxo antes do agrupamento.');
  RETURN jsonb_build_object('id',p_id,'reused',false);
END $fn$;
REVOKE ALL ON FUNCTION public.fin_create_receivable_group(uuid,text,text,uuid[],date,jsonb,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fin_create_receivable_group(uuid,text,text,uuid[],date,jsonb,boolean) TO authenticated;
