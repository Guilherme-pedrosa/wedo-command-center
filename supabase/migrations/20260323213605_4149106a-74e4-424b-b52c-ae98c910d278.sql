UPDATE fin_grupos_receber g
SET os_codigos = sub.codes
FROM (
  SELECT gi.grupo_id, array_agg(DISTINCT gi.os_codigo_original) AS codes
  FROM fin_grupo_receber_itens gi
  WHERE gi.os_codigo_original IS NOT NULL
  GROUP BY gi.grupo_id
) sub
WHERE g.id = sub.grupo_id AND (g.os_codigos IS NULL OR g.os_codigos = '{}');