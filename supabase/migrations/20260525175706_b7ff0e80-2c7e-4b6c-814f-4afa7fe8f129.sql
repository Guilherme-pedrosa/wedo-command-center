-- Reseta sentinel '-0.001' (processado, sem deslocamento) das OS dos últimos 90 dias
-- para que sync-os-details reprocesse e capture hotel/alimentação/hospedagem como reembolso.
UPDATE public.os_index
SET valor_deslocamento = 0
WHERE valor_deslocamento = -0.001
  AND data_saida >= (CURRENT_DATE - INTERVAL '90 days');