-- Entrega/reembolso de transportadora pode não conter a palavra "frete".
-- Exige atividade logística no fornecedor E finalidade de entrega na descrição.
-- Não atribui custos automaticamente: apenas disponibiliza a fonte para rateio.
CREATE OR REPLACE FUNCTION public.fin_comissoes_pagamento_indica_frete(pagamento jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path = public AS $$
 WITH texto AS (
  SELECT translate(lower(coalesce(nullif(pagamento->>'descricao',''), pagamento->'gc_payload_raw'->>'descricao','')),
    'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc') AS descricao,
   translate(lower(coalesce(nullif(pagamento->>'nome_fornecedor',''), pagamento->'gc_payload_raw'->>'nome_fornecedor','')),
    'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc') AS fornecedor
 )
 SELECT descricao ~ 'frete|transporte|carreto'
  OR (fornecedor ~ '\m(transportes?|transportadoras?|logistica|logistic|carretos?|fretes?)\M'
      AND descricao ~ '\m(entrega|coleta|reembolso|reemsolso)\M')
 FROM texto;
$$;
REVOKE ALL ON FUNCTION public.fin_comissoes_pagamento_indica_frete(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_comissoes_pagamento_indica_frete(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.fin_comissoes_fontes_frete()
RETURNS TABLE(tipo text, registro jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
 WITH compras AS (
 SELECT c.* FROM public.gc_compras c
 WHERE c.valor_frete>0
 OR c.codigo IN (SELECT regexp_split_to_table(coalesce(e->'extras',e)->>'conteudo','[^0-9]+')
  FROM public.gc_compras origem CROSS JOIN LATERAL jsonb_array_elements(coalesce(origem.gc_payload_raw->'Compra'->'campos_extras','[]')) e
  WHERE coalesce(e->'extras',e)->>'descricao' ~* 'frete.*pedidos.*compras')
 OR concat(c.gc_payload_raw->'Compra'->'produtos',c.gc_payload_raw->'Compra'->'servicos',c.gc_payload_raw->'Compra'->'pagamentos') ~* 'frete|transporte|carreto'
 OR EXISTS (SELECT 1 FROM public.gc_pagamentos p WHERE public.fin_comissoes_pagamento_indica_frete(to_jsonb(p))
 AND (regexp_match(p.descricao,'(?i)compra\s+de\s+n[^0-9]*([0-9]+)'))[1]=c.codigo)
 )
 SELECT 'compra',to_jsonb(c) FROM compras c
 UNION ALL SELECT 'pagamento',to_jsonb(p) FROM public.gc_pagamentos p
 WHERE public.fin_comissoes_pagamento_indica_frete(to_jsonb(p))
  OR EXISTS (SELECT 1 FROM compras c WHERE (regexp_match(p.descricao,'(?i)compra\s+de\s+n[^0-9]*([0-9]+)'))[1]=c.codigo)
 UNION ALL SELECT 'rateio',jsonb_build_object('venda_id',c.venda_id,'fretes',c.ajustes->'fretes') FROM public.fin_comissoes_conferencias c WHERE jsonb_array_length(coalesce(c.ajustes->'fretes','[]'))>0
 ORDER BY 1,2;
$$;
REVOKE ALL ON FUNCTION public.fin_comissoes_fontes_frete() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fin_comissoes_fontes_frete() TO authenticated;

-- Preserva trava transacional, justificativa, limite real e saldo entre vendas.
CREATE OR REPLACE FUNCTION public.validar_rateio_frete_comissoes() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r jsonb; usado numeric; total numeric; limite numeric; limite_fonte numeric; compra_raw jsonb; compra_codigo text; pagamento_raw jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('fin_comissoes_rateio_frete',0));
 IF jsonb_typeof(coalesce(NEW.ajustes->'fretes','[]')) <> 'array' THEN RAISE EXCEPTION 'Rateios inválidos'; END IF;
 IF (SELECT count(*)<>count(DISTINCT x->>'fonteId') FROM jsonb_array_elements(coalesce(NEW.ajustes->'fretes','[]')) x) THEN RAISE EXCEPTION 'Fonte de frete repetida'; END IF;
 FOR r IN SELECT * FROM jsonb_array_elements(coalesce(NEW.ajustes->'fretes','[]')) LOOP
  total := (r->>'valor')::numeric; limite := (r->>'limite')::numeric;
  IF total IS NULL OR limite IS NULL OR total<0 OR limite<=0 OR total>limite OR total::text IN ('NaN','Infinity','-Infinity') OR limite::text IN ('NaN','Infinity','-Infinity')
   OR coalesce(r->>'fonteId','') !~ '^(compra|pagamento):[0-9]+$' OR length(trim(coalesce(r->>'justificativa','')))=0
  THEN RAISE EXCEPTION 'Informe origem, valor válido e justificativa do frete'; END IF;
  IF split_part(r->>'fonteId',':',1)='compra' THEN
   SELECT coalesce(c.gc_payload_raw->'Compra',c.gc_payload_raw),c.codigo INTO compra_raw,compra_codigo
    FROM public.gc_compras c WHERE c.gc_id=split_part(r->>'fonteId',':',2);
   IF compra_raw IS NULL THEN RAISE EXCEPTION 'Fonte de frete não localizada'; END IF;
   SELECT greatest(coalesce((compra_raw->>'valor_frete')::numeric,0),
    coalesce((SELECT sum((coalesce(p->'pagamento',p)->>'valor')::numeric) FROM jsonb_array_elements(coalesce(compra_raw->'pagamentos','[]')) p WHERE coalesce(p->'pagamento',p)->>'observacao' ~* 'frete|transporte|carreto'),0),
    coalesce((SELECT sum((coalesce(p->'produto',p->'servico',p)->>'valor_total')::numeric) FROM jsonb_array_elements(coalesce(compra_raw->'produtos','[]')||coalesce(compra_raw->'servicos','[]')) p WHERE concat(coalesce(p->'produto',p->'servico',p)->>'nome_produto',coalesce(p->'produto',p->'servico',p)->>'nome_servico') ~* 'frete|transporte|carreto'),0)) INTO limite_fonte;
   IF limite_fonte=0 THEN
    SELECT coalesce(sum(coalesce(nullif(p.gc_payload_raw->>'valor_total',''), nullif(to_jsonb(p)->>'valor_total',''), nullif(to_jsonb(p)->>'valor',''))::numeric),0)
     INTO limite_fonte FROM public.gc_pagamentos p
     WHERE public.fin_comissoes_pagamento_indica_frete(to_jsonb(p))
      AND (regexp_match(p.descricao,'(?i)compra\s+de\s+n[^0-9]*([0-9]+)'))[1]=compra_codigo;
   END IF;
  ELSE
   SELECT p.gc_payload_raw INTO pagamento_raw FROM public.gc_pagamentos p WHERE p.gc_id=split_part(r->>'fonteId',':',2);
   IF pagamento_raw IS NULL THEN RAISE EXCEPTION 'Fonte de frete não localizada'; END IF;
   limite_fonte := (pagamento_raw->>'valor_total')::numeric;
   IF EXISTS(SELECT 1 FROM public.gc_compras c WHERE c.codigo=(regexp_match(pagamento_raw->>'descricao','(?i)compra\s+de\s+n[^0-9]*([0-9]+)'))[1]) THEN RAISE EXCEPTION 'Pedido localizado: vincule pela fonte do pedido para evitar duplicidade'; END IF;
  END IF;
  IF limite_fonte IS NULL OR abs(limite_fonte-limite)>0.02 THEN RAISE EXCEPTION 'Valor da fonte mudou ou não está sincronizado. Atualize antes de ratear.'; END IF;
  SELECT coalesce(sum((x->>'valor')::numeric),0) INTO usado FROM public.fin_comissoes_conferencias c,
   LATERAL jsonb_array_elements(coalesce(c.ajustes->'fretes','[]')) x
   WHERE c.venda_id<>NEW.venda_id AND x->>'fonteId'=r->>'fonteId';
  IF usado+total>limite+0.001 THEN RAISE EXCEPTION 'Frete já rateado em outras vendas. Atualize a conferência.'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
