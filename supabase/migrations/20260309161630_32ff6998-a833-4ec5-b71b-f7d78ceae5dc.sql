
-- Desfazer conciliação errada do extrato 534213c2
UPDATE fin_extrato_inter 
SET reconciliado = false, lancamento_id = null, reconciliado_em = null, reconciliation_rule = null
WHERE id = '534213c2-8633-43f8-b6eb-f204537e18d3';

DELETE FROM fin_extrato_lancamentos WHERE extrato_id = '534213c2-8633-43f8-b6eb-f204537e18d3';

-- Reverter o pago_sistema do lançamento que foi indevidamente marcado
UPDATE fin_pagamentos 
SET pago_sistema = false, pago_sistema_em = null
WHERE id = '142db38c-3c1c-4b2d-b847-9d3e2448a5a3' AND pago_sistema = true;
