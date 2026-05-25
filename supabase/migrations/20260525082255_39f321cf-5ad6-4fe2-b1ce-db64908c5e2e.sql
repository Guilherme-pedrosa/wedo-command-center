-- 1) Coluna gerada numero_nf em fin_nfe_xml_index (extraída da chave NF-e: posição 26-34 → nNF, 9 dígitos)
ALTER TABLE public.fin_nfe_xml_index
  ADD COLUMN IF NOT EXISTS numero_nf TEXT
    GENERATED ALWAYS AS (
      CASE 
        WHEN chave IS NOT NULL AND length(chave) >= 34 
        THEN ltrim(substring(chave from 26 for 9), '0')
        ELSE NULL
      END
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_xml_index_cnpj_numero
  ON public.fin_nfe_xml_index (cnpj_emitente, numero_nf);

-- 2) Nova tabela fin_nfe_match_pendentes
CREATE TABLE IF NOT EXISTS public.fin_nfe_match_pendentes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_gc_id text NOT NULL,
  numero_nfe text,
  cnpj_fornecedor text,
  nome_fornecedor text,
  valor_compra numeric,
  data_compra date,
  motivo text NOT NULL,
  candidatos jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolvido boolean NOT NULL DEFAULT false,
  resolvido_em timestamptz,
  CONSTRAINT fin_nfe_match_pendentes_motivo_chk
    CHECK (motivo IN ('sem_cnpj_compra', 'cnpj_sem_xml', 'valor_fora_tolerancia', 'multiplo_ambiguo', 'sem_numero_nfe')),
  CONSTRAINT fin_nfe_match_pendentes_compra_uk UNIQUE (compra_gc_id)
);

CREATE INDEX IF NOT EXISTS idx_match_pendentes_motivo
  ON public.fin_nfe_match_pendentes (motivo) WHERE resolvido = false;

CREATE INDEX IF NOT EXISTS idx_match_pendentes_cnpj
  ON public.fin_nfe_match_pendentes (cnpj_fornecedor) WHERE resolvido = false;

ALTER TABLE public.fin_nfe_match_pendentes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fin_nfe_match_pendentes_select"
  ON public.fin_nfe_match_pendentes FOR SELECT
  TO authenticated
  USING (
    has_role(auth.uid(), 'admin'::app_role) OR
    has_role(auth.uid(), 'ceo'::app_role) OR
    has_role(auth.uid(), 'gerente_financeiro'::app_role)
  );

CREATE POLICY "fin_nfe_match_pendentes_update"
  ON public.fin_nfe_match_pendentes FOR UPDATE
  TO authenticated
  USING (
    has_role(auth.uid(), 'admin'::app_role) OR
    has_role(auth.uid(), 'ceo'::app_role)
  )
  WITH CHECK (
    has_role(auth.uid(), 'admin'::app_role) OR
    has_role(auth.uid(), 'ceo'::app_role)
  );

-- INSERT/DELETE somente via service_role (edge function)

CREATE TRIGGER trg_fin_nfe_match_pendentes_updated_at
  BEFORE UPDATE ON public.fin_nfe_match_pendentes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();