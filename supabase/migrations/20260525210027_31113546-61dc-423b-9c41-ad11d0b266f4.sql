
UPDATE fin_gc_write_jobs 
SET status = 'erro_fatal', 
    ultimo_erro = COALESCE(ultimo_erro, '') || ' | Cancelado por rollback - fix bug #3 aplicado'
WHERE recurso_id = '73325958'
  AND status IN ('pendente','erro_retentavel','processando')
  AND created_at > now() - interval '30 minutes';

UPDATE fin_gc_price_aprovacoes 
SET status = 'rejeitada', 
    decidido_em = now(),
    decisao_observacao = 'Rollback teste piloto v3 - rebuild após fix bug #3 (valor_custo zero no snapshot pendente)'
WHERE gc_produto_id = '73325958' 
  AND status IN ('pendente','aprovada')
  AND created_at > now() - interval '30 minutes';

ALTER TABLE gc_produtos_cache DISABLE TRIGGER trg_repricing_on_cost_change;
UPDATE gc_produtos_cache 
SET valor_custo = 0.10, updated_at = now() 
WHERE produto_gc_id = '73325958';
ALTER TABLE gc_produtos_cache ENABLE TRIGGER trg_repricing_on_cost_change;
