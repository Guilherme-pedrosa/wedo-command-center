
-- ETAPA 0a: Expandir CHECK de source
ALTER TABLE fin_gc_custo_history DROP CONSTRAINT IF EXISTS fin_gc_custo_history_source_check;
ALTER TABLE fin_gc_custo_history ADD CONSTRAINT fin_gc_custo_history_source_check
  CHECK (source IN ('nf','erp','manual','sync','seed_marco_zero','sync_gc_produtos'));

-- ETAPA 0b: Expandir CHECK de motivo
ALTER TABLE fin_nfe_match_pendentes DROP CONSTRAINT IF EXISTS fin_nfe_match_pendentes_motivo_chk;
ALTER TABLE fin_nfe_match_pendentes ADD CONSTRAINT fin_nfe_match_pendentes_motivo_chk
  CHECK (motivo IN (
    'sem_cnpj_compra','cnpj_sem_xml','valor_fora_tolerancia','multiplo_ambiguo','sem_numero_nfe',
    'custo_zero_no_cadastro_gc','sem_pedido_vinculado'
  ));

-- ETAPA 1: Flag de re-enriquecimento
ALTER TABLE fin_produto_tributos 
  ADD COLUMN IF NOT EXISTS re_enrichment_needed BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_fpt_reenrich 
  ON fin_produto_tributos(re_enrichment_needed) 
  WHERE re_enrichment_needed = true;

-- ETAPA 2: Seed marco zero
INSERT INTO fin_gc_custo_history (gc_produto_id, custo_anterior, custo_novo, source, motivo)
SELECT 
  produto_gc_id, NULL, valor_custo, 'seed_marco_zero', 
  'Snapshot inicial pós-refator matcher v3 — Pedido de Compra como fonte única'
FROM gc_produtos_cache 
WHERE valor_custo IS NOT NULL AND valor_custo > 0
  AND NOT EXISTS (
    SELECT 1 FROM fin_gc_custo_history h 
    WHERE h.gc_produto_id = gc_produtos_cache.produto_gc_id AND h.source = 'seed_marco_zero'
  );

-- ETAPA 3: Wipe matchers legacy frouxos
UPDATE fin_produto_tributos 
SET match_rule = NULL, re_enrichment_needed = true, custo_variavel_real = NULL
WHERE match_rule IN (
  'valor_total','valor_total_fallback','nome_similar','ncm_valor','unico_1x1','xml_rateio','sem_xml_proporcional'
)
OR match_rule LIKE '%+valor_total_fallback'
OR match_rule LIKE '%+unico_1x1'
OR match_rule LIKE '%+xml_rateio';

-- ETAPA 4: Custo zero/negativo → pendência
INSERT INTO fin_nfe_match_pendentes (compra_gc_id, motivo, nome_fornecedor)
SELECT 
  produto_gc_id, 'custo_zero_no_cadastro_gc', 'PRODUTO_CADASTRO::' || nome
FROM gc_produtos_cache 
WHERE COALESCE(valor_custo, 0) <= 0 AND ativo = true
  AND NOT EXISTS (
    SELECT 1 FROM fin_nfe_match_pendentes p 
    WHERE p.compra_gc_id = gc_produtos_cache.produto_gc_id 
      AND p.motivo = 'custo_zero_no_cadastro_gc' AND p.resolvido = false
  );

-- ETAPA 5: Trigger auditoria custo
CREATE OR REPLACE FUNCTION trg_gc_produtos_custo_change() RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.valor_custo IS DISTINCT FROM OLD.valor_custo) THEN
    INSERT INTO fin_gc_custo_history(gc_produto_id, custo_anterior, custo_novo, source, motivo)
    VALUES (NEW.produto_gc_id, OLD.valor_custo, NEW.valor_custo, 'sync_gc_produtos',
            'Mudança detectada via sync automático GC');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS gc_produtos_cache_custo_audit ON gc_produtos_cache;
CREATE TRIGGER gc_produtos_cache_custo_audit
  AFTER UPDATE ON gc_produtos_cache
  FOR EACH ROW EXECUTE FUNCTION trg_gc_produtos_custo_change();

-- ETAPA 6: View canônica
CREATE OR REPLACE VIEW v_produto_custo_atual 
WITH (security_invoker = on) AS
SELECT 
  gpc.produto_gc_id, gpc.nome, gpc.codigo_interno, gpc.ncm, gpc.unidade,
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

COMMENT ON VIEW v_produto_custo_atual IS 
  'Fonte única de custo para precificação. Custo vem de gc_produtos_cache.valor_custo (atualizado automaticamente pelo GC quando pedido dá entrada).';
