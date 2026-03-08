UPDATE fin_extrato_inter
SET data_hora = data_hora + INTERVAL '3 hours'
WHERE data_hora IS NOT NULL
  AND created_at >= NOW() - INTERVAL '30 days'