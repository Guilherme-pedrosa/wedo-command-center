
-- Add structured fields to fin_extrato_inter
ALTER TABLE fin_extrato_inter
  ADD COLUMN IF NOT EXISTS nome_contraparte TEXT,
  ADD COLUMN IF NOT EXISTS tipo_transacao TEXT,
  ADD COLUMN IF NOT EXISTS codigo_barras TEXT,
  ADD COLUMN IF NOT EXISTS reconciliation_rule TEXT;

-- Add recipient_document to fin_pagamentos and fin_recebimentos for CNPJ matching
ALTER TABLE fin_pagamentos
  ADD COLUMN IF NOT EXISTS recipient_document TEXT;

ALTER TABLE fin_recebimentos
  ADD COLUMN IF NOT EXISTS recipient_document TEXT;

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_extrato_reconciliado ON fin_extrato_inter(reconciliado);
CREATE INDEX IF NOT EXISTS idx_extrato_cpf_cnpj ON fin_extrato_inter(cpf_cnpj);
CREATE INDEX IF NOT EXISTS idx_extrato_valor ON fin_extrato_inter(valor);
CREATE INDEX IF NOT EXISTS idx_pagamentos_recipient_doc ON fin_pagamentos(recipient_document);
CREATE INDEX IF NOT EXISTS idx_recebimentos_recipient_doc ON fin_recebimentos(recipient_document);

-- Backfill: ensure reconciliado is never NULL
UPDATE fin_extrato_inter SET reconciliado = false WHERE reconciliado IS NULL;
