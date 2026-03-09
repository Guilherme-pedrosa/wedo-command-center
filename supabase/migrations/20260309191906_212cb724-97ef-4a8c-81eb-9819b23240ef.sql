-- PART 2: Seed fin_plano_contas with all GC cost accounts (tipo = 'despesa')
INSERT INTO fin_plano_contas (gc_id, nome, tipo) VALUES
('27867664', 'Aluguel', 'despesa'),
('27867667', 'Combustivel', 'despesa'),
('27867669', 'Contabilidade', 'despesa'),
('27867673', 'Empréstimos', 'despesa'),
('27867674', 'Encargos funcionários ADM - 13o salário', 'despesa'),
('27867675', 'Encargos Funcionários ADM - Alimentação / Refeição', 'despesa'),
('27867676', 'Encargos funcionários - assist. médica e odontol.', 'despesa'),
('27867677', 'Encargos Funcionários ADM - Exames médicos', 'despesa'),
('27867678', 'Encargos funcionários - FGTS', 'despesa'),
('27867679', 'Encargos Funcionarios ADM - Horas Extras', 'despesa'),
('27867680', 'ENCARGOS SOBRE A FOLHA SALARIAL (INSS, FGTS)', 'despesa'),
('27867681', 'Encargos Funcionários ADM - Auxilio Transporte', 'despesa'),
('27867682', 'Encargos ADM - Rescisões Trabalhistas', 'despesa'),
('27867683', 'Energia elétrica + água', 'despesa'),
('27867685', 'Impostos - coleta de lixo', 'despesa'),
('27867686', 'Impostos - IPTU', 'despesa'),
('27867687', 'Impostos - PIS', 'despesa'),
('27867688', 'Licença ou aluguel de softwares', 'despesa'),
('27867690', 'Manutenção de Equipamentos e Mobiliário Operacional WeDo', 'despesa'),
('27867691', 'Marketing e publicidade', 'despesa'),
('27867692', 'Material de escritório (papelaria, impressão, chamex)', 'despesa'),
('27867694', 'CONTRATAÇÃO DE SERVIÇOS / SALÁRIO ADM', 'despesa'),
('27867695', 'EPI E UNIFORME', 'despesa'),
('27867696', 'Insumos Higiene / Café ADM', 'despesa'),
('27867697', 'Telefonia e internet', 'despesa'),
('27867698', 'Transportadora', 'despesa'),
('27867703', 'COMPRAS PEÇAS PARA USO EM SERVIÇOS APROVADOS', 'despesa'),
('27867704', 'Impostos - COFINS', 'despesa'),
('27867706', 'Impostos - ICMS', 'despesa'),
('27867708', 'Impostos - IRPJ', 'despesa'),
('27867709', 'Impostos - ISS', 'despesa'),
('27867711', 'Taxas / Tarifas Bancárias', 'despesa'),
('27867993', 'Aquisição / Sublocação de Máquinas e Equipamentos para Locação', 'despesa'),
('27912040', 'Hospedagem', 'despesa'),
('27942305', 'CONTRATAÇÃO DE SERVIÇOS TÉCNICOS INTERNOS', 'despesa'),
('27951677', 'SEGURO DE VIDA', 'despesa'),
('27983783', 'Refeições', 'despesa'),
('28034468', 'Despesas com veículos', 'despesa'),
('28046830', 'Bonificação variável', 'despesa'),
('28054594', 'COMISSÕES E BONIFICAÇÕES', 'despesa'),
('28120514', 'Impostos - Simples Nacional', 'despesa'),
('28121757', 'DESPESA COM DOCUMENTAÇÃO, FINANCIAMENTO E ESTRUTURAL GALPÃO WEDO', 'despesa'),
('28145842', 'Encargos funcionários Operacional - Alimentação', 'despesa'),
('28160784', 'Pedágios', 'despesa'),
('28160995', 'Seguro veículos', 'despesa'),
('28188241', 'Despesas com RH - Documentos - Exames - Certificados', 'despesa'),
('28211859', 'Aquisição de Ferramentas, mobiliário e Maquinário para Operações', 'despesa'),
('28223100', 'Estacionamento', 'despesa'),
('28397985', 'Encargos funcionários ADM - Férias', 'despesa'),
('28889388', 'Insumos Eletrônicos / Celulares', 'despesa'),
('29155683', 'PRO-LABORE', 'despesa'),
('30893561', 'Remuneração / Salário Operacionais', 'despesa'),
('30893629', 'Encargos funcionarios Operacional - Horas Extras', 'despesa'),
('30893632', 'Encargos Operacionais - Rescisões Trabalhistas', 'despesa'),
('30893699', 'Encargos funcionários Operacional - Auxílio transporte', 'despesa'),
('30893830', 'Encargos Funcionários Operacional - 13º salário', 'despesa'),
('30894435', 'Manutenção / Compra de Equipamentos e Mobiliário WeDo ADM', 'despesa'),
('30895710', 'Despesas Com Treinamento Técnico (Almoço, Viagem, Hotel, Transporte)', 'despesa'),
('30895711', 'Despesa Com treinamento / Viagem ADM', 'despesa'),
('30896507', 'Encargos funcionários OPERACIONAL - Férias', 'despesa'),
('33283085', 'COMPRA DE PEÇAS PARA REVENDA', 'despesa'),
('33710480', 'Encargos Contrib.Prev Contrib Indiv e Empreg', 'despesa'),
('33720932', 'CONTRATAÇÃO DE SERVIÇOS EXTERNOS', 'despesa'),
('34135304', 'ISSQN Prest.Serv.Próprio', 'despesa'),
('34556490', 'CONSULTORIA TRIBUTÁRIA', 'despesa'),
('34556763', 'BONIFICAÇÃO ADM', 'despesa')
ON CONFLICT (gc_id) DO UPDATE SET nome = EXCLUDED.nome, tipo = EXCLUDED.tipo;

-- PART 1: Fix fin_meta_plano_contas — convert GC numeric IDs to UUIDs
UPDATE fin_meta_plano_contas fmpc
SET plano_contas_id = fpc.id::text
FROM fin_plano_contas fpc
WHERE fpc.gc_id = fmpc.plano_contas_id
  AND fmpc.plano_contas_id ~ '^[0-9]+$';

-- Also update centro_custo_id from codigo to UUID
UPDATE fin_meta_plano_contas fmpc
SET centro_custo_id = fcc.id::text
FROM fin_centros_custo fcc
WHERE fcc.codigo = fmpc.centro_custo_id
  AND fmpc.centro_custo_id ~ '^[0-9]+$';

-- PART 3: Create auvo_expenses_sync table
CREATE TABLE IF NOT EXISTS public.auvo_expenses_sync (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auvo_id       INTEGER UNIQUE NOT NULL,
  type_id       INTEGER NOT NULL,
  type_name     TEXT,
  user_to_id    INTEGER,
  user_to_name  TEXT,
  expense_date  DATE NOT NULL,
  amount        NUMERIC(15,2),
  description   TEXT,
  attachment_url TEXT,
  synced_at     TIMESTAMPTZ DEFAULT now(),
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auvo_exp_date ON auvo_expenses_sync (expense_date);
CREATE INDEX IF NOT EXISTS idx_auvo_exp_type ON auvo_expenses_sync (type_id);
ALTER TABLE auvo_expenses_sync ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon" ON auvo_expenses_sync FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "auth" ON auvo_expenses_sync FOR ALL TO authenticated USING (true) WITH CHECK (true);