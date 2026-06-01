
CREATE OR REPLACE FUNCTION public.fn_dashboard_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_mes  text := to_char(v_hoje, 'YYYY-MM');
  v_result jsonb;
  v_chart jsonb;
BEGIN
  WITH rec AS (
    SELECT
      COALESCE(SUM(CASE WHEN NOT liquidado THEN valor END), 0) AS total_a_receber,
      COUNT(*) FILTER (WHERE NOT liquidado) AS count_a_receber,
      COALESCE(SUM(CASE WHEN NOT liquidado AND data_vencimento < v_hoje THEN valor END), 0) AS total_vencido,
      COUNT(*) FILTER (WHERE NOT liquidado AND data_vencimento < v_hoje) AS count_vencido,
      COALESCE(SUM(CASE WHEN liquidado AND to_char(data_liquidacao,'YYYY-MM') = v_mes THEN valor END), 0) AS recebido_mes,
      COUNT(*) FILTER (WHERE liquidado AND to_char(data_liquidacao,'YYYY-MM') = v_mes) AS count_recebido_mes
    FROM public.gc_recebimentos
  ),
  pag AS (
    SELECT
      COALESCE(SUM(CASE WHEN NOT liquidado THEN valor END), 0) AS total_a_pagar,
      COUNT(*) FILTER (WHERE NOT liquidado) AS count_a_pagar,
      COALESCE(SUM(CASE WHEN liquidado AND to_char(data_liquidacao,'YYYY-MM') = v_mes THEN valor END), 0) AS pago_mes,
      COUNT(*) FILTER (WHERE liquidado AND to_char(data_liquidacao,'YYYY-MM') = v_mes) AS count_pago_mes
    FROM public.gc_pagamentos
  )
  SELECT jsonb_build_object(
    'total_a_receber', rec.total_a_receber,
    'count_a_receber', rec.count_a_receber,
    'total_vencido', rec.total_vencido,
    'count_vencido', rec.count_vencido,
    'recebido_mes', rec.recebido_mes,
    'count_recebido_mes', rec.count_recebido_mes,
    'total_a_pagar', pag.total_a_pagar,
    'count_a_pagar', pag.count_a_pagar,
    'pago_mes', pag.pago_mes,
    'count_pago_mes', pag.count_pago_mes
  ) INTO v_result
  FROM rec, pag;

  WITH months AS (
    SELECT to_char(date_trunc('month', v_hoje) - (i || ' months')::interval, 'YYYY-MM') AS ym,
           date_trunc('month', v_hoje) - (i || ' months')::interval AS mstart
    FROM generate_series(0, 5) i
  ),
  rec_m AS (
    SELECT to_char(data_liquidacao,'YYYY-MM') AS ym, SUM(valor) AS total
    FROM public.gc_recebimentos
    WHERE liquidado AND data_liquidacao >= (date_trunc('month', v_hoje) - interval '5 months')::date
    GROUP BY 1
  ),
  pag_m AS (
    SELECT to_char(data_liquidacao,'YYYY-MM') AS ym, SUM(valor) AS total
    FROM public.gc_pagamentos
    WHERE liquidado AND data_liquidacao >= (date_trunc('month', v_hoje) - interval '5 months')::date
    GROUP BY 1
  )
  SELECT jsonb_agg(jsonb_build_object(
    'ym', months.ym,
    'recebimentos', COALESCE(rec_m.total, 0),
    'pagamentos', COALESCE(pag_m.total, 0)
  ) ORDER BY months.mstart)
  INTO v_chart
  FROM months
  LEFT JOIN rec_m ON rec_m.ym = months.ym
  LEFT JOIN pag_m ON pag_m.ym = months.ym;

  RETURN v_result || jsonb_build_object('chart', v_chart);
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_dashboard_stats() TO authenticated, service_role;
