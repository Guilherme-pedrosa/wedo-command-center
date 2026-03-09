CREATE OR REPLACE VIEW public.vw_conciliacao_extrato AS
SELECT
  e.id,
  e.descricao,
  e.valor AS valor_extrato,
  e.tipo,
  e.data_hora,
  e.nome_contraparte,
  e.cpf_cnpj,
  e.reconciliado,
  e.reconciliado_em,
  e.reconciliation_rule,
  e.lancamento_id,
  e.grupo_receber_id,
  e.grupo_pagar_id,
  e.agenda_id,
  e.contrapartida,
  e.chave_pix,
  e.end_to_end_id,
  e.codigo_barras,
  e.tipo_transacao,
  e.created_at,
  e.payload_raw,

  -- valor_gc
  COALESCE(
    (SELECT SUM(fel.valor_alocado) FROM fin_extrato_lancamentos fel WHERE fel.extrato_id = e.id),
    (SELECT p.valor FROM fin_pagamentos p WHERE p.id = e.lancamento_id),
    (SELECT r.valor FROM fin_recebimentos r WHERE r.id = e.lancamento_id)
  ) AS valor_gc,

  -- qtd_parcelas
  COALESCE(
    (SELECT COUNT(*)::int FROM fin_extrato_lancamentos fel WHERE fel.extrato_id = e.id),
    CASE WHEN e.lancamento_id IS NOT NULL THEN 1 ELSE 0 END
  ) AS qtd_parcelas,

  -- diferenca
  CASE
    WHEN e.lancamento_id IS NULL AND NOT EXISTS (SELECT 1 FROM fin_extrato_lancamentos fel WHERE fel.extrato_id = e.id) THEN NULL::numeric
    ELSE ABS(e.valor - COALESCE(
      (SELECT SUM(fel.valor_alocado) FROM fin_extrato_lancamentos fel WHERE fel.extrato_id = e.id),
      (SELECT p.valor FROM fin_pagamentos p WHERE p.id = e.lancamento_id),
      (SELECT r.valor FROM fin_recebimentos r WHERE r.id = e.lancamento_id),
      0
    ))
  END AS diferenca,

  -- exato
  CASE
    WHEN e.lancamento_id IS NULL AND NOT EXISTS (SELECT 1 FROM fin_extrato_lancamentos fel WHERE fel.extrato_id = e.id) THEN NULL::boolean
    WHEN ABS(e.valor - COALESCE(
      (SELECT SUM(fel.valor_alocado) FROM fin_extrato_lancamentos fel WHERE fel.extrato_id = e.id),
      (SELECT p.valor FROM fin_pagamentos p WHERE p.id = e.lancamento_id),
      (SELECT r.valor FROM fin_recebimentos r WHERE r.id = e.lancamento_id),
      0
    )) <= 0.02 THEN true
    ELSE false
  END AS exato,

  -- NOVO: gc_codigo do lançamento vinculado
  COALESCE(
    (SELECT r.gc_codigo FROM fin_recebimentos r WHERE r.id = e.lancamento_id LIMIT 1),
    (SELECT p.gc_codigo FROM fin_pagamentos p WHERE p.id = e.lancamento_id LIMIT 1),
    (SELECT r2.gc_codigo FROM fin_extrato_lancamentos fel2 JOIN fin_recebimentos r2 ON r2.id = fel2.lancamento_id WHERE fel2.extrato_id = e.id AND fel2.tabela = 'fin_recebimentos' LIMIT 1),
    (SELECT p2.gc_codigo FROM fin_extrato_lancamentos fel3 JOIN fin_pagamentos p2 ON p2.id = fel3.lancamento_id WHERE fel3.extrato_id = e.id AND fel3.tabela = 'fin_pagamentos' LIMIT 1)
  ) AS gc_codigo_vinculado,

  -- NOVO: indica se é recebimento ou pagamento
  CASE
    WHEN e.tipo = 'CREDITO' THEN 'fin_recebimentos'
    WHEN e.tipo = 'DEBITO' THEN 'fin_pagamentos'
    ELSE NULL
  END AS _tabela

FROM fin_extrato_inter e;