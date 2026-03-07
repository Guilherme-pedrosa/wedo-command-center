
-- Add gc_payload_raw and updated_at to gc_recebimentos
ALTER TABLE gc_recebimentos ADD COLUMN IF NOT EXISTS gc_payload_raw JSONB;
ALTER TABLE gc_recebimentos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Add gc_payload_raw and updated_at to gc_pagamentos
ALTER TABLE gc_pagamentos ADD COLUMN IF NOT EXISTS gc_payload_raw JSONB;
ALTER TABLE gc_pagamentos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Add recorrente and frequencia to pagamentos_programados
ALTER TABLE pagamentos_programados ADD COLUMN IF NOT EXISTS recorrente BOOLEAN DEFAULT false;
ALTER TABLE pagamentos_programados ADD COLUMN IF NOT EXISTS frequencia TEXT;

-- Create grupos_pagamentos table
CREATE TABLE IF NOT EXISTS grupos_pagamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  fornecedor_id TEXT,
  nome_fornecedor TEXT,
  valor_total NUMERIC(12,2) DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'aberto',
  inter_pagamento_id TEXT,
  data_vencimento DATE,
  data_pagamento TIMESTAMPTZ,
  valor_pago NUMERIC(12,2),
  observacao TEXT,
  baixado_gc BOOLEAN DEFAULT FALSE,
  baixado_gc_em TIMESTAMPTZ,
  criado_por TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE grupos_pagamentos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon access" ON grupos_pagamentos FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated access" ON grupos_pagamentos FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Create grupo_pagamento_itens table
CREATE TABLE IF NOT EXISTS grupo_pagamento_itens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grupo_id UUID NOT NULL REFERENCES grupos_pagamentos(id) ON DELETE CASCADE,
  gc_pagamento_id TEXT NOT NULL,
  gc_codigo TEXT,
  os_codigo TEXT,
  descricao TEXT,
  valor NUMERIC(12,2),
  baixado_gc BOOLEAN DEFAULT FALSE,
  baixado_gc_em TIMESTAMPTZ,
  tentativas INT DEFAULT 0,
  erro_baixa TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE grupo_pagamento_itens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon access" ON grupo_pagamento_itens FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated access" ON grupo_pagamento_itens FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Enable realtime for key tables
ALTER PUBLICATION supabase_realtime ADD TABLE grupos_financeiros;
ALTER PUBLICATION supabase_realtime ADD TABLE grupos_pagamentos;
