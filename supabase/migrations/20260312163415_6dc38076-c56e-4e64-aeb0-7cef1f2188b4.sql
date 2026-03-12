
-- Table to cache per-product tax profiles from entry NFes
CREATE TABLE public.fin_produto_tributos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gc_produto_id text NOT NULL,
  nome_produto text NOT NULL,
  ncm text,
  -- Last NF de entrada data
  nf_gc_id text,
  nf_numero text,
  nf_data_emissao date,
  fornecedor_nome text,
  -- Effective tax rates (%)
  icms_aliquota numeric DEFAULT 0,
  icms_base numeric DEFAULT 0,
  pis_aliquota numeric DEFAULT 0,
  cofins_aliquota numeric DEFAULT 0,
  ipi_aliquota numeric DEFAULT 0,
  frete_percentual numeric DEFAULT 0,
  -- Absolute values from last NF
  valor_unitario_nf numeric DEFAULT 0,
  valor_icms_unit numeric DEFAULT 0,
  valor_pis_unit numeric DEFAULT 0,
  valor_cofins_unit numeric DEFAULT 0,
  valor_ipi_unit numeric DEFAULT 0,
  valor_frete_unit numeric DEFAULT 0,
  -- Custo efetivo
  custo_efetivo_unit numeric DEFAULT 0,
  -- Metadata
  ultima_atualizacao timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  UNIQUE(gc_produto_id)
);

ALTER TABLE public.fin_produto_tributos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon access" ON public.fin_produto_tributos FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated access" ON public.fin_produto_tributos FOR ALL TO authenticated USING (true) WITH CHECK (true);
