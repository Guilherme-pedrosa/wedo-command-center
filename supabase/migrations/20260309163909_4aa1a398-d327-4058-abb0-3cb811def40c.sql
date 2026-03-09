
-- Drop existing fin_metas and dependencies
DROP TABLE IF EXISTS fin_meta_plano_contas CASCADE;
DROP TABLE IF EXISTS fin_metas CASCADE;

-- PASSO 1: Criar tabela fin_metas
CREATE TABLE fin_metas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          TEXT NOT NULL,
  categoria     TEXT NOT NULL,
  tipo_meta     TEXT NOT NULL,
  meta_valor    NUMERIC(14,2),
  meta_percentual NUMERIC(6,4),
  periodo       TEXT,
  ativo         BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Validation trigger instead of CHECK constraints
CREATE OR REPLACE FUNCTION public.validate_fin_metas()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.categoria NOT IN ('receita', 'custo_variavel', 'custo_fixo') THEN
    RAISE EXCEPTION 'categoria must be receita, custo_variavel, or custo_fixo';
  END IF;
  IF NEW.tipo_meta NOT IN ('absoluto', 'percentual') THEN
    RAISE EXCEPTION 'tipo_meta must be absoluto or percentual';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_fin_metas
BEFORE INSERT OR UPDATE ON fin_metas
FOR EACH ROW EXECUTE FUNCTION public.validate_fin_metas();

-- RLS
ALTER TABLE fin_metas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon access" ON fin_metas FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated access" ON fin_metas FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- PASSO 2: Criar tabela fin_meta_plano_contas
CREATE TABLE fin_meta_plano_contas (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meta_id             UUID NOT NULL REFERENCES fin_metas(id) ON DELETE CASCADE,
  plano_contas_id     TEXT NOT NULL,
  nome_plano          TEXT,
  centro_custo_id     TEXT,
  nome_centro_custo   TEXT,
  peso                NUMERIC(5,4) DEFAULT 1.0
);

CREATE INDEX idx_fmpc_meta_id ON fin_meta_plano_contas(meta_id);
CREATE INDEX idx_fmpc_plano_contas_id ON fin_meta_plano_contas(plano_contas_id);
CREATE INDEX idx_fmpc_centro_custo_id ON fin_meta_plano_contas(centro_custo_id);

ALTER TABLE fin_meta_plano_contas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon access" ON fin_meta_plano_contas FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated access" ON fin_meta_plano_contas FOR ALL TO authenticated USING (true) WITH CHECK (true);
