
-- 1. Backfill fin_extrato_lancamentos para vínculos 1:1 sem parcelas registradas
INSERT INTO fin_extrato_lancamentos (
  extrato_id,
  lancamento_id,
  tabela,
  valor_alocado,
  reconciliation_rule
)
SELECT
  e.id                        AS extrato_id,
  e.lancamento_id             AS lancamento_id,
  CASE
    WHEN e.tipo = 'DEBITO' THEN 'pagamentos'
    ELSE 'recebimentos'
  END                         AS tabela,
  ABS(e.valor)                AS valor_alocado,
  COALESCE(e.reconciliation_rule, 'LINK_JA_PAGO_GC')  AS reconciliation_rule
FROM fin_extrato_inter e
WHERE e.reconciliado = true
  AND e.lancamento_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM fin_extrato_lancamentos fel
    WHERE fel.extrato_id = e.id
  );

-- 2. Recreate view with observacao column
CREATE OR REPLACE VIEW public.vw_conciliacao_extrato AS
SELECT
  e.id,
  e.descricao,
  e.valor                        AS valor_extrato,
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

  COALESCE(
    (SELECT SUM(fel.valor_alocado)
     FROM fin_extrato_lancamentos fel
     WHERE fel.extrato_id = e.id),
    (SELECT p.valor FROM fin_pagamentos p WHERE p.id = e.lancamento_id),
    (SELECT r.valor FROM fin_recebimentos r WHERE r.id = e.lancamento_id),
    0
  ) AS valor_gc,

  COALESCE(
    (SELECT COUNT(*)::int
     FROM fin_extrato_lancamentos fel
     WHERE fel.extrato_id = e.id),
    CASE WHEN e.lancamento_id IS NOT NULL THEN 1 ELSE 0 END
  ) AS qtd_parcelas,

  ABS(
    e.valor - COALESCE(
      (SELECT SUM(fel.valor_alocado)
       FROM fin_extrato_lancamentos fel
       WHERE fel.extrato_id = e.id),
      (SELECT p.valor FROM fin_pagamentos p WHERE p.id = e.lancamento_id),
      (SELECT r.valor FROM fin_recebimentos r WHERE r.id = e.lancamento_id),
      0
    )
  ) AS diferenca,

  CASE
    WHEN ABS(
      e.valor - COALESCE(
        (SELECT SUM(fel.valor_alocado)
         FROM fin_extrato_lancamentos fel
         WHERE fel.extrato_id = e.id),
        (SELECT p.valor FROM fin_pagamentos p WHERE p.id = e.lancamento_id),
        (SELECT r.valor FROM fin_recebimentos r WHERE r.id = e.lancamento_id),
        0
      )
    ) <= 0.02 THEN true
    ELSE false
  END AS exato

FROM fin_extrato_inter e;
