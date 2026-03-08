
-- Delete phantom extrato records (fallback end_to_end_id) where a real record exists
DELETE FROM fin_extrato_inter AS phantom
WHERE phantom.end_to_end_id ~ '^\d{4}-\d{2}-\d{2}-'
  AND EXISTS (
    SELECT 1 FROM fin_extrato_inter AS real_rec
    WHERE real_rec.id != phantom.id
      AND real_rec.valor = phantom.valor
      AND real_rec.tipo = phantom.tipo
      AND DATE(real_rec.data_hora) = DATE(phantom.data_hora)
      AND real_rec.end_to_end_id !~ '^\d{4}-\d{2}-\d{2}-'
  );
