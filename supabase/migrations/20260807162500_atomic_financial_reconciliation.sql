-- Conciliação financeira atômica e protegida contra dupla alocação.
-- Os vínculos históricos são preservados; novas operações que ultrapassem o
-- valor do título são rejeitadas dentro da mesma transação do banco.

CREATE INDEX IF NOT EXISTS idx_fin_extrato_inter_reconciliado_data_hora
  ON public.fin_extrato_inter (reconciliado, data_hora DESC);

CREATE INDEX IF NOT EXISTS idx_fin_extrato_lancamentos_tabela_lancamento
  ON public.fin_extrato_lancamentos (tabela, lancamento_id);

CREATE OR REPLACE FUNCTION public.fn_validate_fin_extrato_allocation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_ext_tipo text;
  v_valor_titulo numeric(14,2);
  v_status text;
  v_alocado_outros numeric(14,2);
BEGIN
  SELECT tipo INTO v_ext_tipo
  FROM public.fin_extrato_inter
  WHERE id = NEW.extrato_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Extrato % não encontrado', NEW.extrato_id;
  END IF;
  IF (v_ext_tipo = 'DEBITO' AND NEW.tabela <> 'pagamentos')
     OR (v_ext_tipo = 'CREDITO' AND NEW.tabela <> 'recebimentos') THEN
    RAISE EXCEPTION 'Direção incompatível entre extrato % e %', v_ext_tipo, NEW.tabela;
  END IF;

  IF NEW.tabela = 'pagamentos' THEN
    SELECT abs(valor)::numeric(14,2), status::text
      INTO v_valor_titulo, v_status
    FROM public.fin_pagamentos
    WHERE id = NEW.lancamento_id
    FOR UPDATE;
  ELSE
    SELECT abs(valor)::numeric(14,2), status::text
      INTO v_valor_titulo, v_status
    FROM public.fin_recebimentos
    WHERE id = NEW.lancamento_id
    FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lançamento % não encontrado em %', NEW.lancamento_id, NEW.tabela;
  END IF;
  IF v_status = 'cancelado' THEN
    RAISE EXCEPTION 'O lançamento % está cancelado e não pode ser conciliado', NEW.lancamento_id;
  END IF;
  IF coalesce(abs(NEW.valor_alocado), 0) <= 0 THEN
    RAISE EXCEPTION 'Valor alocado deve ser maior que zero';
  END IF;

  SELECT coalesce(sum(abs(coalesce(valor_alocado, 0))), 0)::numeric(14,2)
    INTO v_alocado_outros
  FROM public.fin_extrato_lancamentos
  WHERE tabela = NEW.tabela
    AND lancamento_id = NEW.lancamento_id
    AND id <> coalesce(NEW.id, gen_random_uuid());

  IF v_alocado_outros + abs(NEW.valor_alocado) > v_valor_titulo + 0.02 THEN
    RAISE EXCEPTION
      'Alocação rejeitada: lançamento % já tem R$ % vinculados e o título vale R$ %',
      NEW.lancamento_id,
      to_char(v_alocado_outros, 'FM999999990D00'),
      to_char(v_valor_titulo, 'FM999999990D00');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_fin_extrato_allocation
  ON public.fin_extrato_lancamentos;
CREATE TRIGGER trg_validate_fin_extrato_allocation
BEFORE INSERT OR UPDATE OF extrato_id, lancamento_id, tabela, valor_alocado
ON public.fin_extrato_lancamentos
FOR EACH ROW
EXECUTE FUNCTION public.fn_validate_fin_extrato_allocation();

CREATE OR REPLACE FUNCTION public.fin_reconcile_extrato_atomic(
  p_extrato_id uuid,
  p_links jsonb,
  p_reconciliation_rule text DEFAULT 'MANUAL'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ext_tipo text;
  v_ext_valor numeric(14,2);
  v_ext_reconciliado boolean;
  v_link jsonb;
  v_tabela text;
  v_lancamento_id uuid;
  v_valor_alocado numeric(14,2);
  v_total_alocado numeric(14,2) := 0;
  v_valor_titulo numeric(14,2);
  v_status text;
  v_pago_sistema boolean;
  v_liquidado boolean;
  v_gc_baixado boolean;
  v_alocado_antes numeric(14,2);
  v_pago_depois boolean;
  v_representante uuid;
  v_maior_alocacao numeric(14,2) := -1;
  v_input_count integer;
  v_existing_count integer;
  v_matching_count integer;
  v_now timestamptz := now();
BEGIN
  IF p_links IS NULL OR jsonb_typeof(p_links) <> 'array' OR jsonb_array_length(p_links) = 0 THEN
    RAISE EXCEPTION 'Informe pelo menos um lançamento para conciliar';
  END IF;

  SELECT tipo, abs(valor)::numeric(14,2), coalesce(reconciliado, false)
    INTO v_ext_tipo, v_ext_valor, v_ext_reconciliado
  FROM public.fin_extrato_inter
  WHERE id = p_extrato_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Extrato % não encontrado', p_extrato_id;
  END IF;

  v_input_count := jsonb_array_length(p_links);

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        (item->>'lancamento_id')::uuid AS lancamento_id,
        CASE
          WHEN item->>'tabela' IN ('pagamentos', 'fin_pagamentos') THEN 'pagamentos'
          WHEN item->>'tabela' IN ('recebimentos', 'fin_recebimentos') THEN 'recebimentos'
          ELSE item->>'tabela'
        END AS tabela
      FROM jsonb_array_elements(p_links) item
    ) parsed
    GROUP BY tabela, lancamento_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'A conciliação contém lançamentos duplicados';
  END IF;

  -- Repetir exatamente a mesma solicitação é idempotente. Qualquer tentativa
  -- diferente contra um extrato já conciliado é rejeitada.
  IF v_ext_reconciliado THEN
    SELECT count(*) INTO v_existing_count
    FROM public.fin_extrato_lancamentos
    WHERE extrato_id = p_extrato_id;

    SELECT count(*) INTO v_matching_count
    FROM public.fin_extrato_lancamentos fel
    WHERE fel.extrato_id = p_extrato_id
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_links) item
        WHERE (item->>'lancamento_id')::uuid = fel.lancamento_id
          AND CASE
            WHEN item->>'tabela' IN ('pagamentos', 'fin_pagamentos') THEN 'pagamentos'
            WHEN item->>'tabela' IN ('recebimentos', 'fin_recebimentos') THEN 'recebimentos'
            ELSE item->>'tabela'
          END = fel.tabela
          AND abs(abs((item->>'valor_alocado')::numeric) - abs(coalesce(fel.valor_alocado, 0))) <= 0.01
      );

    IF v_existing_count = v_input_count AND v_matching_count = v_input_count THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotent', true,
        'extrato_id', p_extrato_id,
        'links', v_input_count
      );
    END IF;

    RAISE EXCEPTION 'Este extrato já está conciliado com outro lançamento';
  END IF;

  -- Trava os títulos em ordem estável, evitando duas conciliações concorrentes.
  PERFORM id
  FROM public.fin_pagamentos
  WHERE id IN (
    SELECT (item->>'lancamento_id')::uuid
    FROM jsonb_array_elements(p_links) item
    WHERE item->>'tabela' IN ('pagamentos', 'fin_pagamentos')
  )
  ORDER BY id
  FOR UPDATE;

  PERFORM id
  FROM public.fin_recebimentos
  WHERE id IN (
    SELECT (item->>'lancamento_id')::uuid
    FROM jsonb_array_elements(p_links) item
    WHERE item->>'tabela' IN ('recebimentos', 'fin_recebimentos')
  )
  ORDER BY id
  FOR UPDATE;

  -- Primeira passagem: valida todos os vínculos antes de escrever qualquer um.
  FOR v_link IN SELECT value FROM jsonb_array_elements(p_links)
  LOOP
    v_lancamento_id := (v_link->>'lancamento_id')::uuid;
    v_tabela := CASE
      WHEN v_link->>'tabela' IN ('pagamentos', 'fin_pagamentos') THEN 'pagamentos'
      WHEN v_link->>'tabela' IN ('recebimentos', 'fin_recebimentos') THEN 'recebimentos'
      ELSE NULL
    END;
    v_valor_alocado := round(abs((v_link->>'valor_alocado')::numeric), 2);

    IF v_tabela IS NULL THEN
      RAISE EXCEPTION 'Tabela financeira inválida: %', v_link->>'tabela';
    END IF;
    IF v_valor_alocado <= 0 THEN
      RAISE EXCEPTION 'Valor alocado inválido para o lançamento %', v_lancamento_id;
    END IF;
    IF (v_ext_tipo = 'DEBITO' AND v_tabela <> 'pagamentos')
       OR (v_ext_tipo = 'CREDITO' AND v_tabela <> 'recebimentos') THEN
      RAISE EXCEPTION 'Direção incompatível: % do extrato não pode ser ligado a %', v_ext_tipo, v_tabela;
    END IF;

    IF v_tabela = 'pagamentos' THEN
      SELECT abs(valor)::numeric(14,2), status::text, coalesce(pago_sistema, false),
             coalesce(liquidado, false), coalesce(gc_baixado, false)
        INTO v_valor_titulo, v_status, v_pago_sistema, v_liquidado, v_gc_baixado
      FROM public.fin_pagamentos
      WHERE id = v_lancamento_id;
    ELSE
      SELECT abs(valor)::numeric(14,2), status::text, coalesce(pago_sistema, false),
             coalesce(liquidado, false), coalesce(gc_baixado, false)
        INTO v_valor_titulo, v_status, v_pago_sistema, v_liquidado, v_gc_baixado
      FROM public.fin_recebimentos
      WHERE id = v_lancamento_id;
    END IF;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Lançamento % não encontrado em %', v_lancamento_id, v_tabela;
    END IF;
    IF v_status = 'cancelado' THEN
      RAISE EXCEPTION 'O lançamento % está cancelado e não pode ser conciliado', v_lancamento_id;
    END IF;

    SELECT coalesce(sum(abs(coalesce(valor_alocado, 0))), 0)::numeric(14,2)
      INTO v_alocado_antes
    FROM public.fin_extrato_lancamentos
    WHERE tabela = v_tabela
      AND lancamento_id = v_lancamento_id
      AND extrato_id <> p_extrato_id;

    IF v_alocado_antes + v_valor_alocado > v_valor_titulo + 0.02 THEN
      RAISE EXCEPTION
        'Lançamento % já possui R$ % conciliados; nova alocação de R$ % ultrapassa o título de R$ %',
        v_lancamento_id,
        to_char(v_alocado_antes, 'FM999999990D00'),
        to_char(v_valor_alocado, 'FM999999990D00'),
        to_char(v_valor_titulo, 'FM999999990D00');
    END IF;

    v_total_alocado := v_total_alocado + v_valor_alocado;
    IF v_valor_alocado > v_maior_alocacao THEN
      v_maior_alocacao := v_valor_alocado;
      v_representante := v_lancamento_id;
    END IF;
  END LOOP;

  IF abs(v_total_alocado - v_ext_valor) > 0.02 THEN
    RAISE EXCEPTION 'Total alocado R$ % difere do extrato de R$ %',
      to_char(v_total_alocado, 'FM999999990D00'),
      to_char(v_ext_valor, 'FM999999990D00');
  END IF;

  -- Segunda passagem: todas as validações passaram; grava links e estado local.
  FOR v_link IN SELECT value FROM jsonb_array_elements(p_links)
  LOOP
    v_lancamento_id := (v_link->>'lancamento_id')::uuid;
    v_tabela := CASE
      WHEN v_link->>'tabela' IN ('pagamentos', 'fin_pagamentos') THEN 'pagamentos'
      ELSE 'recebimentos'
    END;
    v_valor_alocado := round(abs((v_link->>'valor_alocado')::numeric), 2);

    IF v_tabela = 'pagamentos' THEN
      SELECT abs(valor)::numeric(14,2), coalesce(pago_sistema, false),
             coalesce(liquidado, false), coalesce(gc_baixado, false)
        INTO v_valor_titulo, v_pago_sistema, v_liquidado, v_gc_baixado
      FROM public.fin_pagamentos WHERE id = v_lancamento_id;
    ELSE
      SELECT abs(valor)::numeric(14,2), coalesce(pago_sistema, false),
             coalesce(liquidado, false), coalesce(gc_baixado, false)
        INTO v_valor_titulo, v_pago_sistema, v_liquidado, v_gc_baixado
      FROM public.fin_recebimentos WHERE id = v_lancamento_id;
    END IF;

    SELECT coalesce(sum(abs(coalesce(valor_alocado, 0))), 0)::numeric(14,2)
      INTO v_alocado_antes
    FROM public.fin_extrato_lancamentos
    WHERE tabela = v_tabela
      AND lancamento_id = v_lancamento_id
      AND extrato_id <> p_extrato_id;

    INSERT INTO public.fin_extrato_lancamentos (
      extrato_id, lancamento_id, tabela, valor_alocado, reconciliation_rule
    ) VALUES (
      p_extrato_id, v_lancamento_id, v_tabela, v_valor_alocado, p_reconciliation_rule
    )
    ON CONFLICT (extrato_id, lancamento_id, tabela)
    DO UPDATE SET
      valor_alocado = excluded.valor_alocado,
      reconciliation_rule = excluded.reconciliation_rule;

    v_pago_depois := v_pago_sistema OR v_liquidado OR v_gc_baixado
      OR (v_alocado_antes + v_valor_alocado >= v_valor_titulo - 0.02);

    IF v_tabela = 'pagamentos' THEN
      UPDATE public.fin_pagamentos
      SET pago_sistema = v_pago_depois,
          pago_sistema_em = CASE WHEN v_pago_depois THEN coalesce(pago_sistema_em, v_now) ELSE pago_sistema_em END
      WHERE id = v_lancamento_id;
    ELSE
      UPDATE public.fin_recebimentos
      SET pago_sistema = v_pago_depois,
          pago_sistema_em = CASE WHEN v_pago_depois THEN coalesce(pago_sistema_em, v_now) ELSE pago_sistema_em END
      WHERE id = v_lancamento_id;
    END IF;
  END LOOP;

  UPDATE public.fin_extrato_inter
  SET reconciliado = true,
      reconciliado_em = v_now,
      reconciliation_rule = coalesce(nullif(p_reconciliation_rule, ''), 'MANUAL'),
      lancamento_id = v_representante
  WHERE id = p_extrato_id;

  INSERT INTO public.fin_sync_log (tipo, referencia_id, status, payload)
  VALUES (
    'conciliacao_atomica',
    p_extrato_id::text,
    'success',
    jsonb_build_object(
      'extrato_id', p_extrato_id,
      'rule', p_reconciliation_rule,
      'links', p_links,
      'valor_extrato', v_ext_valor
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'extrato_id', p_extrato_id,
    'links', v_input_count,
    'valor_alocado', v_total_alocado
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fin_undo_reconcile_extrato_atomic(p_extrato_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link record;
  v_links jsonb := '[]'::jsonb;
  v_remaining boolean;
  v_liquidado boolean;
  v_gc_baixado boolean;
BEGIN
  PERFORM 1 FROM public.fin_extrato_inter WHERE id = p_extrato_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Extrato % não encontrado', p_extrato_id;
  END IF;

  FOR v_link IN
    SELECT lancamento_id, tabela, valor_alocado
    FROM public.fin_extrato_lancamentos
    WHERE extrato_id = p_extrato_id
    ORDER BY tabela, lancamento_id
    FOR UPDATE
  LOOP
    v_links := v_links || jsonb_build_array(jsonb_build_object(
      'lancamento_id', v_link.lancamento_id,
      'tabela', v_link.tabela,
      'valor_alocado', v_link.valor_alocado
    ));
  END LOOP;

  DELETE FROM public.fin_extrato_lancamentos WHERE extrato_id = p_extrato_id;

  FOR v_link IN
    SELECT DISTINCT
      (item->>'lancamento_id')::uuid AS lancamento_id,
      item->>'tabela' AS tabela
    FROM jsonb_array_elements(v_links) item
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM public.fin_extrato_lancamentos
      WHERE lancamento_id = v_link.lancamento_id AND tabela = v_link.tabela
    ) INTO v_remaining;

    IF v_link.tabela = 'pagamentos' THEN
      SELECT coalesce(liquidado, false), coalesce(gc_baixado, false)
        INTO v_liquidado, v_gc_baixado
      FROM public.fin_pagamentos WHERE id = v_link.lancamento_id FOR UPDATE;

      IF FOUND AND NOT v_remaining AND NOT v_liquidado AND NOT v_gc_baixado THEN
        UPDATE public.fin_pagamentos
        SET pago_sistema = false, pago_sistema_em = null
        WHERE id = v_link.lancamento_id;
      END IF;
    ELSE
      SELECT coalesce(liquidado, false), coalesce(gc_baixado, false)
        INTO v_liquidado, v_gc_baixado
      FROM public.fin_recebimentos WHERE id = v_link.lancamento_id FOR UPDATE;

      IF FOUND AND NOT v_remaining AND NOT v_liquidado AND NOT v_gc_baixado THEN
        UPDATE public.fin_recebimentos
        SET pago_sistema = false, pago_sistema_em = null
        WHERE id = v_link.lancamento_id;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.fin_extrato_inter
  SET reconciliado = false,
      reconciliado_em = null,
      reconciliation_rule = null,
      lancamento_id = null
  WHERE id = p_extrato_id;

  INSERT INTO public.fin_sync_log (tipo, referencia_id, status, payload)
  VALUES (
    'conciliacao_desfeita',
    p_extrato_id::text,
    'success',
    jsonb_build_object('extrato_id', p_extrato_id, 'links_removidos', v_links)
  );

  RETURN jsonb_build_object(
    'success', true,
    'extrato_id', p_extrato_id,
    'links_removidos', jsonb_array_length(v_links)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fin_reconcile_extrato_atomic(uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fin_undo_reconcile_extrato_atomic(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fin_reconcile_extrato_atomic(uuid, jsonb, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_undo_reconcile_extrato_atomic(uuid) TO anon, authenticated, service_role;

-- Recupera conciliações legadas 1:1 que possuem lancamento_id válido, mas não
-- receberam a linha de rastreabilidade na tabela N:N.
INSERT INTO public.fin_extrato_lancamentos (
  extrato_id, lancamento_id, tabela, valor_alocado, reconciliation_rule
)
SELECT e.id, e.lancamento_id, 'pagamentos', abs(e.valor), coalesce(e.reconciliation_rule, 'LEGACY_BACKFILL')
FROM public.fin_extrato_inter e
JOIN public.fin_pagamentos p ON p.id = e.lancamento_id
WHERE e.reconciliado IS TRUE
  AND e.tipo = 'DEBITO'
  AND abs(p.valor) + 0.02 >= abs(e.valor)
  AND NOT EXISTS (SELECT 1 FROM public.fin_extrato_lancamentos own_link WHERE own_link.extrato_id = e.id)
  AND NOT EXISTS (
    SELECT 1 FROM public.fin_extrato_lancamentos used_link
    WHERE used_link.tabela = 'pagamentos' AND used_link.lancamento_id = e.lancamento_id
  )
ON CONFLICT (extrato_id, lancamento_id, tabela) DO NOTHING;

INSERT INTO public.fin_extrato_lancamentos (
  extrato_id, lancamento_id, tabela, valor_alocado, reconciliation_rule
)
SELECT e.id, e.lancamento_id, 'recebimentos', abs(e.valor), coalesce(e.reconciliation_rule, 'LEGACY_BACKFILL')
FROM public.fin_extrato_inter e
JOIN public.fin_recebimentos r ON r.id = e.lancamento_id
WHERE e.reconciliado IS TRUE
  AND e.tipo = 'CREDITO'
  AND abs(r.valor) + 0.02 >= abs(e.valor)
  AND NOT EXISTS (SELECT 1 FROM public.fin_extrato_lancamentos own_link WHERE own_link.extrato_id = e.id)
  AND NOT EXISTS (
    SELECT 1 FROM public.fin_extrato_lancamentos used_link
    WHERE used_link.tabela = 'recebimentos' AND used_link.lancamento_id = e.lancamento_id
  )
ON CONFLICT (extrato_id, lancamento_id, tabela) DO NOTHING;

-- O próprio sincronismo do GC confirma que estes títulos já estão liquidados.
-- O backfill elimina falsos "Pend. GC" sem tentar efetuar uma nova baixa.
UPDATE public.fin_pagamentos
SET gc_baixado = true,
    gc_baixado_em = coalesce(gc_baixado_em, data_liquidacao::timestamp AT TIME ZONE 'America/Sao_Paulo', now())
WHERE pago_sistema IS TRUE
  AND liquidado IS TRUE
  AND gc_baixado IS NOT TRUE
  AND status::text <> 'cancelado';

UPDATE public.fin_recebimentos
SET gc_baixado = true,
    gc_baixado_em = coalesce(gc_baixado_em, data_liquidacao::timestamp AT TIME ZONE 'America/Sao_Paulo', now())
WHERE pago_sistema IS TRUE
  AND liquidado IS TRUE
  AND gc_baixado IS NOT TRUE
  AND status::text <> 'cancelado';
