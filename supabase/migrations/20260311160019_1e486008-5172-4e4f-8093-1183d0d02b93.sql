
-- Function: when a fin_recebimentos row changes status/liquidado, 
-- check if its grupo's items are all settled and update grupo status accordingly
CREATE OR REPLACE FUNCTION public.fn_sync_grupo_receber_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_grupo_id uuid;
  v_total int;
  v_pagos int;
  v_novo_status text;
BEGIN
  -- Only care about recebimentos that belong to a grupo
  v_grupo_id := COALESCE(NEW.grupo_id, OLD.grupo_id);
  IF v_grupo_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Count total and paid items in this grupo
  SELECT 
    COUNT(*),
    COUNT(*) FILTER (WHERE r.status IN ('pago', 'liquidado', 'baixado') OR r.liquidado = true)
  INTO v_total, v_pagos
  FROM fin_grupo_receber_itens gi
  JOIN fin_recebimentos r ON r.id = gi.recebimento_id
  WHERE gi.grupo_id = v_grupo_id;

  -- Determine new status
  IF v_total = 0 THEN
    v_novo_status := 'aberto';
  ELSIF v_pagos >= v_total THEN
    v_novo_status := 'pago';
  ELSIF v_pagos > 0 THEN
    v_novo_status := 'pago_parcial';
  ELSE
    v_novo_status := 'aberto';
  END IF;

  -- Update grupo only if status changed
  UPDATE fin_grupos_receber 
  SET status = v_novo_status::fin_status_grupo,
      data_pagamento = CASE WHEN v_novo_status = 'pago' THEN now() ELSE data_pagamento END,
      updated_at = now()
  WHERE id = v_grupo_id 
    AND (status IS DISTINCT FROM v_novo_status::fin_status_grupo);

  RETURN NEW;
END;
$$;

-- Trigger on fin_recebimentos for status/liquidado changes
CREATE TRIGGER trg_sync_grupo_receber_status
AFTER UPDATE OF status, liquidado ON fin_recebimentos
FOR EACH ROW
WHEN (OLD.grupo_id IS NOT NULL OR NEW.grupo_id IS NOT NULL)
EXECUTE FUNCTION fn_sync_grupo_receber_status();
