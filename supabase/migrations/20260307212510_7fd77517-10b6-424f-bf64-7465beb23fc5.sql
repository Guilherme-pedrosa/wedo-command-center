
-- ══ ENUMS ══
CREATE TYPE fin_status_grupo AS ENUM ('aberto','aguardando_pagamento','pago','pago_parcial','cancelado');
CREATE TYPE fin_status_lancamento AS ENUM ('pendente','pago','vencido','cancelado');
CREATE TYPE fin_tipo_lancamento AS ENUM ('receita','despesa');
CREATE TYPE fin_origem AS ENUM ('gc_os','gc_venda','gc_contrato','manual','inter','outro');
CREATE TYPE fin_recorrencia AS ENUM ('nenhuma','diaria','semanal','quinzenal','mensal','bimestral','trimestral','semestral','anual');

-- ══ PLANO DE CONTAS ══
CREATE TABLE fin_plano_contas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gc_id TEXT,
  codigo TEXT,
  nome TEXT NOT NULL,
  tipo fin_tipo_lancamento NOT NULL,
  pai_id UUID REFERENCES fin_plano_contas(id),
  ativo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ══ CENTROS DE CUSTO ══
CREATE TABLE fin_centros_custo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT,
  nome TEXT NOT NULL,
  ativo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ══ CONTAS BANCÁRIAS ══
CREATE TABLE fin_contas_bancarias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gc_id TEXT,
  nome TEXT NOT NULL,
  banco TEXT,
  agencia TEXT,
  conta TEXT,
  tipo TEXT DEFAULT 'corrente',
  saldo_inicial NUMERIC(14,2) DEFAULT 0,
  saldo_atual NUMERIC(14,2) DEFAULT 0,
  is_inter BOOLEAN DEFAULT FALSE,
  ativa BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ══ FORMAS DE PAGAMENTO ══
CREATE TABLE fin_formas_pagamento (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gc_id TEXT,
  nome TEXT NOT NULL,
  tipo TEXT,
  ativo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ══ CACHE CLIENTES ══
CREATE TABLE fin_clientes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gc_id TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  cpf_cnpj TEXT,
  email TEXT,
  telefone TEXT,
  last_synced TIMESTAMPTZ DEFAULT now()
);

-- ══ CACHE FORNECEDORES ══
CREATE TABLE fin_fornecedores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gc_id TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  cpf_cnpj TEXT,
  email TEXT,
  telefone TEXT,
  chave_pix TEXT,
  last_synced TIMESTAMPTZ DEFAULT now()
);

-- ══ CONFIGURAÇÕES FINANCEIRAS ══
CREATE TABLE fin_configuracoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chave TEXT NOT NULL UNIQUE,
  valor TEXT,
  descricao TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed configurações
INSERT INTO fin_configuracoes (chave, valor, descricao) VALUES
  ('inter_chave_pix', '', 'Chave PIX para cobranças Inter'),
  ('inter_numero_conta', '', 'Número da conta Inter'),
  ('inter_titular_conta', '', 'Titular da conta Inter'),
  ('inter_ambiente', 'prod', 'prod | sandbox'),
  ('inter_polling_ativo', 'true', 'Polling de extrato ativo'),
  ('inter_polling_interval', '30', 'Intervalo de polling em minutos'),
  ('gc_sync_interval', '30', 'Intervalo sync GC em minutos'),
  ('gc_sync_ativo', 'true', 'Sync automático GC ativo'),
  ('confirmacao_modo', 'texto', 'texto | botao');

-- ══ GRUPOS A RECEBER ══
CREATE TABLE fin_grupos_receber (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  cliente_gc_id TEXT,
  nome_cliente TEXT,
  valor_total NUMERIC(14,2) DEFAULT 0,
  status fin_status_grupo DEFAULT 'aberto',
  data_vencimento DATE,
  data_pagamento TIMESTAMPTZ,
  valor_recebido NUMERIC(14,2),
  observacao TEXT,
  inter_txid TEXT,
  inter_qrcode TEXT,
  inter_copia_cola TEXT,
  inter_pago_em TIMESTAMPTZ,
  inter_pagador TEXT,
  gc_baixado BOOLEAN DEFAULT FALSE,
  gc_baixado_em TIMESTAMPTZ,
  gc_baixado_por TEXT,
  itens_total INT DEFAULT 0,
  itens_baixados INT DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ══ GRUPOS A PAGAR ══
CREATE TABLE fin_grupos_pagar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  fornecedor_gc_id TEXT,
  nome_fornecedor TEXT,
  valor_total NUMERIC(14,2) DEFAULT 0,
  status fin_status_grupo DEFAULT 'aberto',
  data_vencimento DATE,
  data_pagamento TIMESTAMPTZ,
  valor_pago NUMERIC(14,2),
  observacao TEXT,
  inter_pagamento_id TEXT,
  inter_pago_em TIMESTAMPTZ,
  inter_favorecido TEXT,
  gc_baixado BOOLEAN DEFAULT FALSE,
  gc_baixado_em TIMESTAMPTZ,
  gc_baixado_por TEXT,
  itens_total INT DEFAULT 0,
  itens_baixados INT DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ══ LANÇAMENTOS A RECEBER ══
CREATE TABLE fin_recebimentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gc_id TEXT UNIQUE,
  gc_codigo TEXT,
  gc_payload_raw JSONB,
  descricao TEXT NOT NULL,
  os_codigo TEXT,
  nf_numero TEXT,
  origem fin_origem DEFAULT 'manual',
  tipo TEXT DEFAULT 'os',
  valor NUMERIC(14,2) NOT NULL,
  desconto NUMERIC(14,2) DEFAULT 0,
  plano_contas_id UUID REFERENCES fin_plano_contas(id),
  centro_custo_id UUID REFERENCES fin_centros_custo(id),
  conta_bancaria_id UUID REFERENCES fin_contas_bancarias(id),
  forma_pagamento_id UUID REFERENCES fin_formas_pagamento(id),
  cliente_gc_id TEXT,
  nome_cliente TEXT,
  data_emissao DATE DEFAULT CURRENT_DATE,
  data_vencimento DATE,
  data_competencia DATE,
  data_liquidacao DATE,
  status fin_status_lancamento DEFAULT 'pendente',
  liquidado BOOLEAN DEFAULT FALSE,
  pago_sistema BOOLEAN DEFAULT FALSE,
  pago_sistema_em TIMESTAMPTZ,
  gc_baixado BOOLEAN DEFAULT FALSE,
  gc_baixado_em TIMESTAMPTZ,
  grupo_id UUID REFERENCES fin_grupos_receber(id) ON DELETE SET NULL,
  recorrencia fin_recorrencia DEFAULT 'nenhuma',
  recorrencia_pai_id UUID REFERENCES fin_recebimentos(id),
  observacao TEXT,
  created_by TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ══ LANÇAMENTOS A PAGAR ══
CREATE TABLE fin_pagamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gc_id TEXT UNIQUE,
  gc_codigo TEXT,
  gc_payload_raw JSONB,
  descricao TEXT NOT NULL,
  os_codigo TEXT,
  nf_numero TEXT,
  origem fin_origem DEFAULT 'manual',
  tipo TEXT DEFAULT 'os',
  valor NUMERIC(14,2) NOT NULL,
  desconto NUMERIC(14,2) DEFAULT 0,
  plano_contas_id UUID REFERENCES fin_plano_contas(id),
  centro_custo_id UUID REFERENCES fin_centros_custo(id),
  conta_bancaria_id UUID REFERENCES fin_contas_bancarias(id),
  forma_pagamento_id UUID REFERENCES fin_formas_pagamento(id),
  fornecedor_gc_id TEXT,
  nome_fornecedor TEXT,
  data_emissao DATE DEFAULT CURRENT_DATE,
  data_vencimento DATE,
  data_competencia DATE,
  data_liquidacao DATE,
  status fin_status_lancamento DEFAULT 'pendente',
  liquidado BOOLEAN DEFAULT FALSE,
  pago_sistema BOOLEAN DEFAULT FALSE,
  pago_sistema_em TIMESTAMPTZ,
  gc_baixado BOOLEAN DEFAULT FALSE,
  gc_baixado_em TIMESTAMPTZ,
  grupo_id UUID REFERENCES fin_grupos_pagar(id) ON DELETE SET NULL,
  recorrencia fin_recorrencia DEFAULT 'nenhuma',
  recorrencia_pai_id UUID REFERENCES fin_pagamentos(id),
  observacao TEXT,
  created_by TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ══ ITENS DE GRUPO A RECEBER ══
CREATE TABLE fin_grupo_receber_itens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grupo_id UUID NOT NULL REFERENCES fin_grupos_receber(id) ON DELETE CASCADE,
  recebimento_id UUID NOT NULL REFERENCES fin_recebimentos(id) ON DELETE RESTRICT,
  valor NUMERIC(14,2),
  gc_baixado BOOLEAN DEFAULT FALSE,
  gc_baixado_em TIMESTAMPTZ,
  tentativas INT DEFAULT 0,
  ultimo_erro TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(grupo_id, recebimento_id)
);

-- ══ ITENS DE GRUPO A PAGAR ══
CREATE TABLE fin_grupo_pagar_itens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grupo_id UUID NOT NULL REFERENCES fin_grupos_pagar(id) ON DELETE CASCADE,
  pagamento_id UUID NOT NULL REFERENCES fin_pagamentos(id) ON DELETE RESTRICT,
  valor NUMERIC(14,2),
  gc_baixado BOOLEAN DEFAULT FALSE,
  gc_baixado_em TIMESTAMPTZ,
  tentativas INT DEFAULT 0,
  ultimo_erro TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(grupo_id, pagamento_id)
);

-- ══ AGENDA DE PAGAMENTOS PROGRAMADOS ══
CREATE TABLE fin_agenda_pagamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  descricao TEXT NOT NULL,
  fornecedor_gc_id TEXT,
  nome_fornecedor TEXT,
  chave_pix_destino TEXT,
  tipo_chave TEXT DEFAULT 'cnpj',
  valor NUMERIC(14,2) NOT NULL,
  data_vencimento DATE NOT NULL,
  recorrencia fin_recorrencia DEFAULT 'nenhuma',
  recorrencia_pai_id UUID REFERENCES fin_agenda_pagamentos(id),
  plano_contas_id UUID REFERENCES fin_plano_contas(id),
  centro_custo_id UUID REFERENCES fin_centros_custo(id),
  conta_bancaria_id UUID REFERENCES fin_contas_bancarias(id),
  status TEXT DEFAULT 'pendente',
  inter_pagamento_id TEXT,
  executado_em TIMESTAMPTZ,
  gc_pagamento_id UUID REFERENCES fin_pagamentos(id),
  gc_baixado BOOLEAN DEFAULT FALSE,
  ultimo_erro TEXT,
  observacao TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ══ EXTRATO INTER ══
CREATE TABLE fin_extrato_inter (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  end_to_end_id TEXT UNIQUE,
  tipo TEXT,
  valor NUMERIC(14,2),
  data_hora TIMESTAMPTZ,
  descricao TEXT,
  contrapartida TEXT,
  cpf_cnpj TEXT,
  reconciliado BOOLEAN DEFAULT FALSE,
  grupo_receber_id UUID REFERENCES fin_grupos_receber(id),
  grupo_pagar_id UUID REFERENCES fin_grupos_pagar(id),
  agenda_id UUID REFERENCES fin_agenda_pagamentos(id),
  lancamento_id UUID,
  reconciliado_em TIMESTAMPTZ,
  payload_raw JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ══ LOG DE SINCRONIZAÇÃO FINANCEIRO ══
CREATE TABLE fin_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo TEXT NOT NULL,
  referencia_id TEXT,
  status TEXT NOT NULL,
  payload JSONB,
  resposta JSONB,
  erro TEXT,
  duracao_ms INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ══ RLS ══
ALTER TABLE fin_plano_contas ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_centros_custo ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_contas_bancarias ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_formas_pagamento ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_fornecedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_configuracoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_grupos_receber ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_grupos_pagar ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_recebimentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_pagamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_grupo_receber_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_grupo_pagar_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_agenda_pagamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_extrato_inter ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_sync_log ENABLE ROW LEVEL SECURITY;

-- Policies: matching existing project pattern (anon + authenticated access)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fin_plano_contas','fin_centros_custo','fin_contas_bancarias',
    'fin_formas_pagamento','fin_clientes','fin_fornecedores',
    'fin_configuracoes','fin_grupos_receber','fin_grupos_pagar',
    'fin_recebimentos','fin_pagamentos','fin_grupo_receber_itens',
    'fin_grupo_pagar_itens','fin_agenda_pagamentos',
    'fin_extrato_inter','fin_sync_log'
  ] LOOP
    EXECUTE format('CREATE POLICY "Anon access" ON %s FOR ALL USING (true) WITH CHECK (true)', t);
    EXECUTE format('CREATE POLICY "Authenticated access" ON %s FOR ALL TO authenticated USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- ══ INDEXES ══
CREATE INDEX ON fin_recebimentos (gc_id);
CREATE INDEX ON fin_recebimentos (cliente_gc_id);
CREATE INDEX ON fin_recebimentos (status);
CREATE INDEX ON fin_recebimentos (data_vencimento);
CREATE INDEX ON fin_recebimentos (grupo_id);
CREATE INDEX ON fin_recebimentos (liquidado);
CREATE INDEX ON fin_pagamentos (gc_id);
CREATE INDEX ON fin_pagamentos (fornecedor_gc_id);
CREATE INDEX ON fin_pagamentos (status);
CREATE INDEX ON fin_pagamentos (data_vencimento);
CREATE INDEX ON fin_pagamentos (liquidado);
CREATE INDEX ON fin_grupos_receber (status);
CREATE INDEX ON fin_grupos_receber (inter_txid);
CREATE INDEX ON fin_grupos_pagar (status);
CREATE INDEX ON fin_grupos_pagar (inter_pagamento_id);
CREATE INDEX ON fin_extrato_inter (end_to_end_id);
CREATE INDEX ON fin_extrato_inter (reconciliado);
CREATE INDEX ON fin_sync_log (tipo);
CREATE INDEX ON fin_sync_log (created_at DESC);
