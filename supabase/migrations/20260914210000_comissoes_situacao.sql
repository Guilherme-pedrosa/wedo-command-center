-- Retirada/reinclusão gerencial: preserva venda, ajustes e pagamentos registrados.
ALTER TABLE public.fin_comissoes_conferencias
  ADD COLUMN retirada boolean NOT NULL DEFAULT false,
  ADD COLUMN motivo_retirada text NOT NULL DEFAULT '',
  ADD COLUMN situacao_alterada_em timestamptz,
  ADD COLUMN situacao_alterada_por uuid REFERENCES auth.users(id),
  ADD CONSTRAINT comissoes_motivo_retirada CHECK (
    (retirada AND length(btrim(motivo_retirada)) BETWEEN 1 AND 2000)
    OR (NOT retirada AND motivo_retirada = '')
  );

CREATE TABLE public.fin_comissoes_situacao_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venda_id uuid NOT NULL REFERENCES public.gc_vendas(id),
  vendedor_nome text NOT NULL,
  usuario_id uuid NOT NULL REFERENCES auth.users(id),
  usuario_nome text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  motivo text NOT NULL CHECK (length(btrim(motivo)) BETWEEN 1 AND 2000),
  retirada_antes boolean NOT NULL,
  retirada_depois boolean NOT NULL,
  snapshot jsonb NOT NULL,
  CHECK (retirada_antes <> retirada_depois)
);
CREATE INDEX comissoes_situacao_eventos_venda ON public.fin_comissoes_situacao_eventos(venda_id, created_at DESC, id);
ALTER TABLE public.fin_comissoes_situacao_eventos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fin_comissoes_situacao_eventos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.fin_comissoes_situacao_eventos TO authenticated;
CREATE POLICY comissoes_situacao_eventos_read ON public.fin_comissoes_situacao_eventos
  FOR SELECT TO authenticated USING (true);
-- Não conceder INSERT/UPDATE/DELETE: o evento é produzido apenas pela RPC.

CREATE OR REPLACE FUNCTION public.validar_situacao_comissoes() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  mudou boolean;
  anterior boolean := false;
  justificativa text;
  venda jsonb;
  nome_usuario text;
  pago numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    anterior := OLD.retirada;
    mudou := ROW(NEW.retirada, NEW.motivo_retirada, NEW.situacao_alterada_em, NEW.situacao_alterada_por)
      IS DISTINCT FROM ROW(OLD.retirada, OLD.motivo_retirada, OLD.situacao_alterada_em, OLD.situacao_alterada_por);
  ELSE
    mudou := NEW.retirada OR NEW.motivo_retirada <> '' OR NEW.situacao_alterada_em IS NOT NULL OR NEW.situacao_alterada_por IS NOT NULL;
  END IF;
  IF NOT mudou THEN RETURN NEW; END IF;

  -- SECURITY INVOKER preserva o papel chamador. A função administrativa é
  -- SECURITY DEFINER; um upsert autenticado não pode forjar esse papel via GUC.
  IF current_user <> pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = 'public.fin_comissoes_alterar_situacao(uuid[],boolean,text)'::regprocedure))
    OR auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin')
    OR NEW.retirada = anterior THEN
    RAISE EXCEPTION 'Altere a situação pela operação de retirada/reinclusão com motivo' USING ERRCODE = '42501';
  END IF;
  justificativa := btrim(coalesce(current_setting('app.fin_comissoes_motivo', true), ''));
  IF length(justificativa) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Informe o motivo da retirada ou reinclusão, com até 2000 caracteres' USING ERRCODE = '22023';
  END IF;
  NEW.motivo_retirada := CASE WHEN NEW.retirada THEN justificativa ELSE '' END;
  NEW.situacao_alterada_em := clock_timestamp();
  NEW.situacao_alterada_por := auth.uid();
  NEW.conferido := false;
  NEW.assinatura := '';
  SELECT to_jsonb(v) INTO venda FROM public.gc_vendas v WHERE v.id = NEW.venda_id;
  SELECT p.nome INTO nome_usuario FROM public.profiles p WHERE p.id = auth.uid();
  SELECT coalesce(sum(p.valor), 0) INTO pago FROM public.fin_comissoes_pagamentos p WHERE p.venda_id = NEW.venda_id;
  INSERT INTO public.fin_comissoes_situacao_eventos (
    venda_id, vendedor_nome, usuario_id, usuario_nome, motivo, retirada_antes, retirada_depois, snapshot
  ) VALUES (
    NEW.venda_id,
    coalesce(nullif(btrim(NEW.ajustes->>'vendedorNome'), ''), nullif(btrim(venda->'gc_payload_raw'->>'nome_vendedor'), ''), 'Vendedor não informado'),
    auth.uid(), coalesce(nome_usuario, ''), justificativa, anterior, NEW.retirada,
    jsonb_build_object('codigo_venda', venda->>'codigo', 'cliente_nome', venda->>'nome_cliente',
      'valor_venda', venda->'valor_total', 'total_comissao_pago', pago,
      'conferencia_anterior', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END)
  );
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.fin_comissoes_alterar_situacao(p_venda_ids uuid[], p_retirada boolean, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  venda_ids uuid[];
  venda_id_atual uuid;
  conferencia public.fin_comissoes_conferencias%ROWTYPE;
  tem_conferencia boolean;
  alteradas integer := 0;
  contexto_anterior text := current_setting('app.fin_comissoes_motivo', true);
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Somente administradores podem retirar ou reincluir comissões' USING ERRCODE = '42501';
  END IF;
  IF p_retirada IS NULL OR p_venda_ids IS NULL OR cardinality(p_venda_ids) NOT BETWEEN 1 AND 200
    OR array_position(p_venda_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Selecione entre 1 e 200 vendas por operação' USING ERRCODE = '22023';
  END IF;
  IF length(btrim(coalesce(p_motivo, ''))) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Informe o motivo da retirada ou reinclusão, com até 2000 caracteres' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO venda_ids FROM unnest(p_venda_ids) x;
  -- Mesma exclusão mútua do registro de pagamento, inclusive em lotes:
  -- pagamento anterior é preservado; retirada anterior bloqueia novo pagamento.
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_comissoes_situacao_pagamento', 0));
  -- Ordem única entre lotes concorrentes; não substitui ajustes ou pagamentos.
  PERFORM v.id FROM public.gc_vendas v WHERE v.id = ANY(venda_ids) ORDER BY v.id FOR UPDATE;
  IF (SELECT count(*) FROM public.gc_vendas v WHERE v.id = ANY(venda_ids)) <> cardinality(venda_ids) THEN
    RAISE EXCEPTION 'Uma ou mais vendas não foram localizadas. Nenhuma comissão foi alterada' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.fin_comissoes_motivo', btrim(p_motivo), true);
  FOREACH venda_id_atual IN ARRAY venda_ids LOOP
    SELECT c.* INTO conferencia FROM public.fin_comissoes_conferencias c WHERE c.venda_id = venda_id_atual FOR UPDATE;
    tem_conferencia := FOUND;
    IF coalesce(conferencia.retirada, false) = p_retirada THEN CONTINUE; END IF;
    IF tem_conferencia THEN
      UPDATE public.fin_comissoes_conferencias SET retirada = p_retirada WHERE venda_id = venda_id_atual;
    ELSE
      INSERT INTO public.fin_comissoes_conferencias(venda_id, retirada) VALUES (venda_id_atual, true);
    END IF;
    alteradas := alteradas + 1;
  END LOOP;
  PERFORM set_config('app.fin_comissoes_motivo', coalesce(contexto_anterior, ''), true);
  RETURN jsonb_build_object('solicitadas', cardinality(venda_ids), 'alteradas', alteradas);
END $$;
REVOKE ALL ON FUNCTION public.fin_comissoes_alterar_situacao(uuid[],boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_comissoes_alterar_situacao(uuid[],boolean,text) TO authenticated;
REVOKE ALL ON FUNCTION public.validar_situacao_comissoes() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER comissoes_00_validar_situacao BEFORE INSERT OR UPDATE ON public.fin_comissoes_conferencias
  FOR EACH ROW EXECUTE FUNCTION public.validar_situacao_comissoes();

-- Proteção no servidor: uma tela aberta antes da retirada não pode registrar
-- novo pagamento. Pagamentos anteriores permanecem intactos para conferência.
CREATE OR REPLACE FUNCTION public.validar_pagamento_situacao_comissoes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE retirada_atual boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Somente administradores podem registrar pagamentos de comissão' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_comissoes_situacao_pagamento', 0));
  PERFORM v.id FROM public.gc_vendas v WHERE v.id = NEW.venda_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda não localizada para registrar a comissão' USING ERRCODE = '22023';
  END IF;
  SELECT c.retirada INTO retirada_atual FROM public.fin_comissoes_conferencias c
    WHERE c.venda_id = NEW.venda_id FOR UPDATE;
  IF coalesce(retirada_atual, false) THEN
    RAISE EXCEPTION 'Comissão retirada: reinclua com motivo antes de registrar novo pagamento' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.validar_pagamento_situacao_comissoes() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER comissoes_00_validar_pagamento BEFORE INSERT ON public.fin_comissoes_pagamentos
  FOR EACH ROW EXECUTE FUNCTION public.validar_pagamento_situacao_comissoes();

-- Retirar comissão não altera rateio: permite a retirada mesmo se uma fonte
-- antiga mudou no GC. Rateios continuam validados ao efetivamente salvar ajustes.
DROP TRIGGER comissoes_validar_frete ON public.fin_comissoes_conferencias;
CREATE TRIGGER comissoes_validar_frete BEFORE INSERT OR UPDATE OF ajustes ON public.fin_comissoes_conferencias
  FOR EACH ROW WHEN (coalesce(NEW.ajustes->'fretes', '[]'::jsonb) <> '[]'::jsonb)
  EXECUTE FUNCTION public.validar_rateio_frete_comissoes();
