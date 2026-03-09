
-- SEED Receitas
INSERT INTO fin_metas (nome, categoria, tipo_meta, meta_valor) VALUES
  ('AT + Higienização de Coifas', 'receita', 'absoluto', 194000),
  ('Contratos PCM',               'receita', 'absoluto', 50449.19),
  ('Ecolab / Chamados',           'receita', 'absoluto', 36000),
  ('Locação de Equipamentos',     'receita', 'absoluto', 10000),
  ('Venda de Produtos / Peças',   'receita', 'absoluto', 30000),
  ('Químicos',                    'receita', 'absoluto', 5000);

-- SEED Custos Variáveis
INSERT INTO fin_metas (nome, categoria, tipo_meta, meta_percentual) VALUES
  ('Impostos (DAS/ISS/IRPJ/CSLL)', 'custo_variavel', 'percentual', 0.160),
  ('Custo com Peças e Estoque',    'custo_variavel', 'percentual', 0.245),
  ('Comissões (Técnicos + Vendedores)', 'custo_variavel', 'percentual', 0.057),
  ('Combustível',                  'custo_variavel', 'percentual', 0.040),
  ('Manutenção / IPVA / Seguro Veículos', 'custo_variavel', 'percentual', 0.020),
  ('Sublocação de Máquinas',       'custo_variavel', 'percentual', 0.005),
  ('Hospedagem',                   'custo_variavel', 'percentual', 0.004),
  ('Pedágio',                      'custo_variavel', 'percentual', 0.003),
  ('Estacionamento',               'custo_variavel', 'percentual', 0.002);

-- SEED Custos Fixos
INSERT INTO fin_metas (nome, categoria, tipo_meta, meta_valor) VALUES
  ('Aluguel / Galpão',             'custo_fixo', 'absoluto', 4305.00),
  ('Energia + Água',               'custo_fixo', 'absoluto', 1800.00),
  ('Internet + Telefonia',         'custo_fixo', 'absoluto', 1200.00),
  ('Sistemas / Software / NFe',    'custo_fixo', 'absoluto', 5910.00),
  ('Contabilidade',                'custo_fixo', 'absoluto', 3000.00),
  ('Consultoria Tributária',       'custo_fixo', 'absoluto', 3000.00),
  ('Folha ADM',                    'custo_fixo', 'absoluto', 10000.00),
  ('Folha Técnico',                'custo_fixo', 'absoluto', 18000.00),
  ('Pró-Labore',                   'custo_fixo', 'absoluto', 6000.00),
  ('Empréstimos / Consórcio',      'custo_fixo', 'absoluto', 12897.51),
  ('Seguro de Vida Colaboradores', 'custo_fixo', 'absoluto', 950.00),
  ('Seguro Carros',                'custo_fixo', 'absoluto', 2800.00),
  ('EPI / Uniformes',              'custo_fixo', 'absoluto', 950.00),
  ('Refeições',                    'custo_fixo', 'absoluto', 4400.00),
  ('Rastreador Veicular',          'custo_fixo', 'absoluto', 400.00),
  ('Papelaria / Escritório',       'custo_fixo', 'absoluto', 300.00),
  ('Limpeza / Insumos Internos',   'custo_fixo', 'absoluto', 500.00),
  ('Manutenção Celular / TI',      'custo_fixo', 'absoluto', 600.00),
  ('RH / Certificados / Treinamentos', 'custo_fixo', 'absoluto', 800.00),
  ('Ferramentas / Mobiliário',     'custo_fixo', 'absoluto', 416.67),
  ('Marketing / Publicidade',      'custo_fixo', 'absoluto', 1000.00),
  ('IPVA (veículos)',              'custo_fixo', 'absoluto', 1200.00);
