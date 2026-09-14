-- Conferência gerencial: nenhuma baixa financeira ou transferência é executada.
CREATE TABLE IF NOT EXISTS public.fin_comissoes_config (
  id text PRIMARY KEY DEFAULT 'global' CHECK (id = 'global'),
  parametros jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.fin_comissoes_conferencias (
  venda_id uuid PRIMARY KEY REFERENCES public.gc_vendas(id),
  ajustes jsonb NOT NULL DEFAULT '{}',
  conferido boolean NOT NULL DEFAULT false,
  assinatura text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);
CREATE TABLE IF NOT EXISTS public.fin_comissoes_pagamentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venda_id uuid NOT NULL REFERENCES public.gc_vendas(id),
  valor numeric(14,2) NOT NULL CHECK (valor > 0),
  data_pagamento date NOT NULL CHECK (data_pagamento <= CURRENT_DATE),
  forma_pagamento text NOT NULL CHECK (length(trim(forma_pagamento)) > 0),
  observacao text NOT NULL DEFAULT '',
  snapshot jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id)
);
CREATE TABLE IF NOT EXISTS public.fin_comissoes_auditoria (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tabela text NOT NULL,
  registro_id text NOT NULL,
  antes jsonb,
  depois jsonb NOT NULL,
  usuario_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fin_comissoes_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_comissoes_conferencias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_comissoes_pagamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_comissoes_auditoria ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.fin_comissoes_config, public.fin_comissoes_conferencias, public.fin_comissoes_pagamentos, public.fin_comissoes_auditoria TO authenticated;
GRANT UPDATE ON public.fin_comissoes_config TO authenticated;
GRANT INSERT, UPDATE ON public.fin_comissoes_conferencias TO authenticated;
GRANT INSERT ON public.fin_comissoes_pagamentos TO authenticated;
CREATE POLICY comissoes_config_read ON public.fin_comissoes_config FOR SELECT TO authenticated USING (true);
CREATE POLICY comissoes_config_write ON public.fin_comissoes_config FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE POLICY comissoes_conferencia_read ON public.fin_comissoes_conferencias FOR SELECT TO authenticated USING (true);
CREATE POLICY comissoes_conferencia_insert ON public.fin_comissoes_conferencias FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE POLICY comissoes_conferencia_update ON public.fin_comissoes_conferencias FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE POLICY comissoes_pagamentos_read ON public.fin_comissoes_pagamentos FOR SELECT TO authenticated USING (true);
CREATE POLICY comissoes_pagamentos_insert ON public.fin_comissoes_pagamentos FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(),'admin') AND created_by = auth.uid());
CREATE POLICY comissoes_auditoria_read ON public.fin_comissoes_auditoria FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));

CREATE OR REPLACE FUNCTION public.auditar_comissoes() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME IN ('fin_comissoes_conferencias','fin_comissoes_config') THEN
    NEW.updated_at := now();
    IF TG_TABLE_NAME = 'fin_comissoes_conferencias' THEN NEW.updated_by := auth.uid(); END IF;
  ELSE NEW.created_by := auth.uid(); NEW.created_at := now(); END IF;
  INSERT INTO public.fin_comissoes_auditoria(tabela,registro_id,antes,depois,usuario_id)
  VALUES (TG_TABLE_NAME,coalesce(to_jsonb(NEW)->>'venda_id',to_jsonb(NEW)->>'id'),CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,to_jsonb(NEW),auth.uid());
  RETURN NEW;
END $$;
CREATE TRIGGER comissoes_conferencia_audit BEFORE INSERT OR UPDATE ON public.fin_comissoes_conferencias FOR EACH ROW EXECUTE FUNCTION public.auditar_comissoes();
CREATE TRIGGER comissoes_config_audit BEFORE UPDATE ON public.fin_comissoes_config FOR EACH ROW EXECUTE FUNCTION public.auditar_comissoes();
CREATE TRIGGER comissoes_pagamento_audit BEFORE INSERT ON public.fin_comissoes_pagamentos FOR EACH ROW EXECUTE FUNCTION public.auditar_comissoes();

-- Cópia conferida dos parâmetros do Pick & Pack em 14/09/2026; não é apuração fiscal.
INSERT INTO public.fin_comissoes_config(id,parametros) VALUES ('global',
'{"config":{"impostoPct":14,"custoFixoPct":0,"garantiaPct":0,"margemMinima":19,"margemMeta":30,"custoPorKm":1.05,"alimentacaoDia":25,"moAdminHora":30,"moAdminHorasPadrao":1,"premiacaoPecaPct":1,"premiacaoServicoPct":15,"cdbAnualPct":15},"margemAposComissao":false,"origem":"Parâmetros do Pick & Pack conferidos em 14/09/2026"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fin_comissoes_dados(inicio date, fim date)
RETURNS TABLE(venda jsonb, recebimentos jsonb, conferencia jsonb, pagamentos jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT to_jsonb(v) || jsonb_build_object('codigo_unico',(SELECT count(*) FROM public.gc_vendas outra WHERE outra.codigo=v.codigo)=1),
    coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.data_vencimento,r.gc_id) FROM public.gc_recebimentos r
      WHERE r.tipo='venda' AND (
        nullif(r.gc_payload_raw->>'venda_id','')=v.gc_id OR
        (nullif(r.gc_payload_raw->>'venda_id','') IS NULL AND
         (regexp_match(r.descricao,'(?i)venda\s+de\s+n[^0-9]*([0-9]+)'))[1]=v.codigo AND
         (SELECT count(*) FROM public.gc_vendas outra WHERE outra.codigo=v.codigo)=1)
      )), '[]'::jsonb),
    (SELECT to_jsonb(c) FROM public.fin_comissoes_conferencias c WHERE c.venda_id=v.id),
    coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.data_pagamento,p.id) FROM public.fin_comissoes_pagamentos p WHERE p.venda_id=v.id),'[]'::jsonb)
  FROM public.gc_vendas v WHERE v.data BETWEEN inicio AND fim AND fim >= inicio AND fim-inicio <= 366
    AND coalesce(v.valor_produtos,0)>0
  ORDER BY v.data DESC,v.id;
$$;
REVOKE ALL ON FUNCTION public.fin_comissoes_dados(date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_comissoes_dados(date,date) TO authenticated;


-- Não limitar fretes ao mês da venda: compras e baixas podem ocorrer antes/depois.
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
 OR EXISTS (SELECT 1 FROM public.gc_pagamentos p WHERE p.descricao ~* 'frete|transporte|carreto'
 AND (regexp_match(p.descricao,'(?i)compra\s+de\s+n[^0-9]*([0-9]+)'))[1]=c.codigo)
 )
 SELECT 'compra',to_jsonb(c) FROM compras c
 UNION ALL SELECT 'pagamento',to_jsonb(p) FROM public.gc_pagamentos p WHERE p.descricao ~* 'frete|transporte|carreto' OR EXISTS (SELECT 1 FROM compras c WHERE (regexp_match(p.descricao,'(?i)compra\s+de\s+n[^0-9]*([0-9]+)'))[1]=c.codigo)
 UNION ALL SELECT 'rateio',jsonb_build_object('venda_id',c.venda_id,'fretes',c.ajustes->'fretes') FROM public.fin_comissoes_conferencias c WHERE jsonb_array_length(coalesce(c.ajustes->'fretes','[]'))>0
 ORDER BY 1,2;
$$;
REVOKE ALL ON FUNCTION public.fin_comissoes_fontes_frete() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fin_comissoes_fontes_frete() TO authenticated;

-- Serializa as conferências para evitar dois usuários consumirem o mesmo saldo.
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
   IF limite_fonte=0 THEN SELECT coalesce(sum((p.gc_payload_raw->>'valor_total')::numeric),0) INTO limite_fonte FROM public.gc_pagamentos p WHERE p.descricao ~* 'frete|transporte|carreto' AND (regexp_match(p.descricao,'(?i)compra\s+de\s+n[^0-9]*([0-9]+)'))[1]=compra_codigo; END IF;
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
CREATE TRIGGER comissoes_validar_frete BEFORE INSERT OR UPDATE ON public.fin_comissoes_conferencias
FOR EACH ROW EXECUTE FUNCTION public.validar_rateio_frete_comissoes();
