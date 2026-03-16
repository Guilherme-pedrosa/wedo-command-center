
CREATE OR REPLACE FUNCTION public.fn_sync_grupo_receber_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_grupo_id uuid;
  v_total int;
  v_pagos int;
  v_novo_status text;
BEGIN
  v_grupo_id := COALESCE(NEW.grupo_id, OLD.grupo_id);
  IF v_grupo_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT 
    COUNT(*),
    COUNT(*) FILTER (WHERE r.status = 'pago' OR r.liquidado = true)
  INTO v_total, v_pagos
  FROM fin_grupo_receber_itens gi
  JOIN fin_recebimentos r ON r.id = gi.recebimento_id
  WHERE gi.grupo_id = v_grupo_id;

  IF v_total = 0 THEN
    v_novo_status := 'aberto';
  ELSIF v_pagos >= v_total THEN
    v_novo_status := 'pago';
  ELSIF v_pagos > 0 THEN
    v_novo_status := 'pago_parcial';
  ELSE
    v_novo_status := 'aberto';
  END IF;

  UPDATE fin_grupos_receber 
  SET status = v_novo_status::fin_status_grupo,
      data_pagamento = CASE WHEN v_novo_status = 'pago' THEN now() ELSE data_pagamento END,
      updated_at = now()
  WHERE id = v_grupo_id 
    AND (status IS DISTINCT FROM v_novo_status::fin_status_grupo);

  RETURN NEW;
END;
$function$;
