
-- Delete ghost/fallback duplicate extrato records (keep the best one per valor+tipo+day)
DELETE FROM fin_extrato_inter
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY valor, tipo, DATE_TRUNC('day', data_hora::timestamptz)
        ORDER BY
          (nome_contraparte IS NOT NULL AND nome_contraparte != '') DESC,
          (cpf_cnpj IS NOT NULL AND cpf_cnpj != '') DESC,
          (end_to_end_id NOT LIKE '%webhook%' AND end_to_end_id NOT LIKE '____-__-__-%') DESC,
          created_at ASC
      ) AS rn
    FROM fin_extrato_inter
    WHERE reconciliado = false
  ) ranked
  WHERE rn > 1
);

-- Backfill status nos já pagos (enum: pendente, pago, vencido, cancelado)
UPDATE fin_pagamentos SET status = 'pago' WHERE pago_sistema = true AND (status IS NULL OR status = 'pendente');
UPDATE fin_recebimentos SET status = 'pago' WHERE pago_sistema = true AND (status IS NULL OR status = 'pendente');

-- Ensure reconciliado defaults
UPDATE fin_extrato_inter SET reconciliado = false WHERE reconciliado IS NULL;
