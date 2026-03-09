
DROP VIEW IF EXISTS public.vw_conciliacao_extrato;

CREATE VIEW public.vw_conciliacao_extrato AS
SELECT id,
    descricao,
    valor AS valor_extrato,
    tipo,
    data_hora,
    nome_contraparte,
    cpf_cnpj,
    reconciliado,
    reconciliado_em,
    reconciliation_rule,
    lancamento_id,
    grupo_receber_id,
    grupo_pagar_id,
    agenda_id,
    contrapartida,
    chave_pix,
    end_to_end_id,
    codigo_barras,
    tipo_transacao,
    created_at,
    payload_raw,
    COALESCE(( SELECT sum(fel.valor_alocado)
           FROM fin_extrato_lancamentos fel
          WHERE fel.extrato_id = e.id), ( SELECT p.valor
           FROM fin_pagamentos p
          WHERE p.id = e.lancamento_id), ( SELECT r.valor
           FROM fin_recebimentos r
          WHERE r.id = e.lancamento_id)) AS valor_gc,
    COALESCE(( SELECT count(*)::integer
           FROM fin_extrato_lancamentos fel
          WHERE fel.extrato_id = e.id),
        CASE
            WHEN lancamento_id IS NOT NULL THEN 1
            ELSE 0
        END) AS qtd_parcelas,
        CASE
            WHEN lancamento_id IS NULL AND NOT EXISTS ( SELECT 1 FROM fin_extrato_lancamentos fel WHERE fel.extrato_id = e.id) THEN NULL::numeric
            ELSE abs(valor - COALESCE(( SELECT sum(fel.valor_alocado) FROM fin_extrato_lancamentos fel WHERE fel.extrato_id = e.id), ( SELECT p.valor FROM fin_pagamentos p WHERE p.id = e.lancamento_id), ( SELECT r.valor FROM fin_recebimentos r WHERE r.id = e.lancamento_id), 0::numeric))
        END AS diferenca,
        CASE
            WHEN lancamento_id IS NULL AND NOT EXISTS ( SELECT 1 FROM fin_extrato_lancamentos fel WHERE fel.extrato_id = e.id) THEN NULL::boolean
            WHEN abs(valor - COALESCE(( SELECT sum(fel.valor_alocado) FROM fin_extrato_lancamentos fel WHERE fel.extrato_id = e.id), ( SELECT p.valor FROM fin_pagamentos p WHERE p.id = e.lancamento_id), ( SELECT r.valor FROM fin_recebimentos r WHERE r.id = e.lancamento_id), 0::numeric)) <= 0.02 THEN true
            ELSE false
        END AS exato,
    COALESCE(( SELECT r.gc_codigo FROM fin_recebimentos r WHERE r.id = e.lancamento_id LIMIT 1), ( SELECT p.gc_codigo FROM fin_pagamentos p WHERE p.id = e.lancamento_id LIMIT 1), ( SELECT r2.gc_codigo FROM fin_extrato_lancamentos fel2 JOIN fin_recebimentos r2 ON r2.id = fel2.lancamento_id WHERE fel2.extrato_id = e.id AND fel2.tabela = 'fin_recebimentos' LIMIT 1), ( SELECT p2.gc_codigo FROM fin_extrato_lancamentos fel3 JOIN fin_pagamentos p2 ON p2.id = fel3.lancamento_id WHERE fel3.extrato_id = e.id AND fel3.tabela = 'fin_pagamentos' LIMIT 1)) AS gc_codigo_vinculado,
    COALESCE(( SELECT r.gc_id FROM fin_recebimentos r WHERE r.id = e.lancamento_id LIMIT 1), ( SELECT p.gc_id FROM fin_pagamentos p WHERE p.id = e.lancamento_id LIMIT 1), ( SELECT r2.gc_id FROM fin_extrato_lancamentos fel2 JOIN fin_recebimentos r2 ON r2.id = fel2.lancamento_id WHERE fel2.extrato_id = e.id AND fel2.tabela = 'fin_recebimentos' LIMIT 1), ( SELECT p2.gc_id FROM fin_extrato_lancamentos fel3 JOIN fin_pagamentos p2 ON p2.id = fel3.lancamento_id WHERE fel3.extrato_id = e.id AND fel3.tabela = 'fin_pagamentos' LIMIT 1)) AS gc_id_vinculado,
    CASE
        WHEN tipo = 'CREDITO' THEN 'fin_recebimentos'
        WHEN tipo = 'DEBITO' THEN 'fin_pagamentos'
        ELSE NULL
    END AS _tabela
FROM fin_extrato_inter e;
