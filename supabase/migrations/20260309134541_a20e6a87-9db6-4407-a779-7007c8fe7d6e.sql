UPDATE fin_extrato_inter
SET reconciliado = false, reconciliado_em = NULL
WHERE reconciliation_rule IN ('SEM_PAR_GC', 'TRANSFERENCIA_INTERNA', 'PIX_DEVOLVIDO_MANUAL')
AND reconciliado = true