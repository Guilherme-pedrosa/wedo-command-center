ALTER TABLE gc_produtos_cache ADD COLUMN IF NOT EXISTS origem text;
ALTER TABLE fin_produto_tributos ADD COLUMN IF NOT EXISTS origem text;

DROP VIEW IF EXISTS public.v_produto_custo_atual;

CREATE VIEW public.v_produto_custo_atual 
WITH (security_invoker = on) AS
SELECT 
  gpc.produto_gc_id, gpc.nome, gpc.codigo_interno, gpc.ncm, gpc.origem, gpc.unidade,
  gpc.valor_custo AS custo_variavel_real, gpc.valor_venda_padrao, gpc.valores,
  gpc.estoque, gpc.nome_grupo,
  CASE 
    WHEN gpc.valor_custo IS NULL OR gpc.valor_custo <= 0 THEN 'pendente_custo_zero'
    WHEN EXISTS (
      SELECT 1 FROM fin_produto_tributos t 
      WHERE t.gc_produto_id = gpc.produto_gc_id AND t.match_rule LIKE 'pedido_compra_gc%'
    ) THEN 'ok_com_tributo'
    ELSE 'ok_sem_tributo'
  END AS status_custo,
  gpc.ultima_sincronizacao, gpc.ativo
FROM gc_produtos_cache gpc
WHERE gpc.ativo = true;

GRANT SELECT ON public.v_produto_custo_atual TO authenticated;
GRANT SELECT ON public.v_produto_custo_atual TO service_role;