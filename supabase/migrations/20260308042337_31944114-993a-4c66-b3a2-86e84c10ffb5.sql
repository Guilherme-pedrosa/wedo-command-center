CREATE TABLE IF NOT EXISTS fin_extrato_lancamentos (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extrato_id           UUID NOT NULL REFERENCES fin_extrato_inter(id) ON DELETE CASCADE,
  lancamento_id        UUID NOT NULL,
  tabela               TEXT NOT NULL CHECK (tabela IN ('pagamentos', 'recebimentos')),
  valor_alocado        NUMERIC(12,2),
  reconciliation_rule  TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (extrato_id, lancamento_id, tabela)
);

CREATE INDEX idx_fel_extrato     ON fin_extrato_lancamentos(extrato_id);
CREATE INDEX idx_fel_lancamento  ON fin_extrato_lancamentos(lancamento_id);
CREATE INDEX idx_fel_tabela      ON fin_extrato_lancamentos(tabela);

ALTER TABLE fin_extrato_lancamentos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon access" ON fin_extrato_lancamentos FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated access" ON fin_extrato_lancamentos FOR ALL TO authenticated USING (true) WITH CHECK (true);