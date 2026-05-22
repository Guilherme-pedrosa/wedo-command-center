-- =====================================================
-- FASE C — gc_produtos_cache (schema CORRETO com valores JSONB)
-- =====================================================

CREATE TABLE public.gc_produtos_cache (
  produto_gc_id          TEXT PRIMARY KEY,
  nome                   TEXT NOT NULL,
  codigo_interno         TEXT,
  codigo_barra           TEXT,
  nome_grupo             TEXT,
  grupo_id               TEXT,
  ncm                    TEXT,
  unidade                TEXT,
  estoque                NUMERIC(14,4),
  valor_custo            NUMERIC(14,4),
  valor_venda_padrao     NUMERIC(14,4),
  valores                JSONB NOT NULL DEFAULT '[]'::jsonb,
  possui_variacao        BOOLEAN DEFAULT false,
  possui_composicao      BOOLEAN DEFAULT false,
  movimenta_estoque      BOOLEAN DEFAULT true,
  peso                   NUMERIC(10,3),
  ativo                  BOOLEAN NOT NULL DEFAULT true,
  raw_gc                 JSONB,
  ultima_sincronizacao   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT valores_must_be_array CHECK (jsonb_typeof(valores) = 'array')
);

CREATE INDEX idx_gc_produtos_cache_nome 
  ON public.gc_produtos_cache USING gin (to_tsvector('portuguese', coalesce(nome,'')));
CREATE INDEX idx_gc_produtos_cache_codigo 
  ON public.gc_produtos_cache(codigo_interno);
CREATE INDEX idx_gc_produtos_cache_codigo_barra 
  ON public.gc_produtos_cache(codigo_barra) WHERE codigo_barra IS NOT NULL;
CREATE INDEX idx_gc_produtos_cache_grupo 
  ON public.gc_produtos_cache(grupo_id);
CREATE INDEX idx_gc_produtos_cache_ativo 
  ON public.gc_produtos_cache(ativo) WHERE ativo = true;
CREATE INDEX idx_gc_produtos_cache_estoque 
  ON public.gc_produtos_cache(estoque) WHERE estoque > 0;
CREATE INDEX idx_gc_produtos_cache_valores 
  ON public.gc_produtos_cache USING gin (valores jsonb_path_ops);

ALTER TABLE public.gc_produtos_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gc_produtos_cache select por role"
  ON public.gc_produtos_cache FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'gerente_comercial'::app_role)
    OR public.has_role(auth.uid(), 'gerente_financeiro'::app_role)
    OR public.has_role(auth.uid(), 'vendedor'::app_role)
  );

CREATE POLICY "gc_produtos_cache service role escreve"
  ON public.gc_produtos_cache FOR ALL
  TO service_role
  USING (true) 
  WITH CHECK (true);

CREATE TRIGGER trg_gc_produtos_cache_updated_at
  BEFORE UPDATE ON public.gc_produtos_cache
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE VIEW public.v_produto_tabela_mc AS
SELECT
  p.produto_gc_id,
  p.nome AS produto_nome,
  p.codigo_interno,
  p.estoque,
  p.valor_custo AS custo_gc,
  pt.custo_variavel_real AS custo_nf,
  COALESCE(pt.custo_variavel_real, p.valor_custo) AS custo_efetivo,
  CASE 
    WHEN pt.custo_variavel_real IS NOT NULL AND pt.custo_variavel_real > 0 THEN 'completo'
    WHEN p.valor_custo IS NOT NULL AND p.valor_custo > 0 THEN 'rapido'
    ELSE 'sem_custo'
  END AS modo_calculo,
  (v.elem ->> 'tipo_id')::text AS tipo_id,
  (v.elem ->> 'nome_tipo')::text AS nome_tipo,
  NULLIF(v.elem ->> 'valor_venda','')::numeric(14,4) AS valor_venda,
  NULLIF(v.elem ->> 'lucro_utilizado','')::numeric(10,4) AS lucro_utilizado_gc,
  pol.margem_minima,
  pol.modo_sugestao,
  pol.exige_aprovacao_ceo,
  CASE 
    WHEN NULLIF(v.elem ->> 'valor_venda','')::numeric > 0 
      AND COALESCE(pt.custo_variavel_real, p.valor_custo) IS NOT NULL THEN
      ROUND(
        (
          (NULLIF(v.elem ->> 'valor_venda','')::numeric 
           - COALESCE(pt.custo_variavel_real, p.valor_custo)
           - NULLIF(v.elem ->> 'valor_venda','')::numeric 
             * (SELECT valor::numeric FROM public.fin_configuracoes WHERE chave = 'TRIB_SAIDA_VENDA_TOTAL')
          ) / NULLIF(v.elem ->> 'valor_venda','')::numeric
        )::numeric, 4
      )
    ELSE NULL
  END AS margem_contribuicao
FROM public.gc_produtos_cache p
CROSS JOIN LATERAL jsonb_array_elements(p.valores) AS v(elem)
LEFT JOIN public.fin_produto_tributos pt 
  ON pt.gc_produto_id = p.produto_gc_id
LEFT JOIN public.fin_politica_markup_tabela pol 
  ON pol.tipo_id = (v.elem ->> 'tipo_id')::text
WHERE p.ativo = true;

COMMENT ON VIEW public.v_produto_tabela_mc IS 
  'Margem de contribuição por (produto, tabela GC). Usada pelo Motor 1 (Sentinela Margem). modo_calculo: completo (tem NF) | rapido (só GC) | sem_custo (alerta).';