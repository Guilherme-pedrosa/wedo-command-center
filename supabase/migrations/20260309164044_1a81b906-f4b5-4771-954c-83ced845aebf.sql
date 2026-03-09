
-- === RECEITAS ===
INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867720', 'Execução de Serviços Aprovados', '501357', 'OPERAÇÕES COZINHAS'
FROM fin_metas WHERE nome = 'AT + Higienização de Coifas';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867720', 'Execução de Serviços Aprovados', '638661', 'OPERAÇÕES COZINHA'
FROM fin_metas WHERE nome = 'AT + Higienização de Coifas';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867721', 'Contratos de serviços', '501357', 'OPERAÇÕES COZINHAS'
FROM fin_metas WHERE nome = 'Contratos PCM';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867721', 'Contratos de serviços', '638661', 'OPERAÇÕES COZINHA'
FROM fin_metas WHERE nome = 'Contratos PCM';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867720', 'Execução de Serviços Aprovados', '566288', 'OPERAÇÃO CHAMADOS'
FROM fin_metas WHERE nome = 'Ecolab / Chamados';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867722', 'Locação de equipamentos', NULL, NULL
FROM fin_metas WHERE nome = 'Locação de Equipamentos';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867718', 'Vendas de produtos', NULL, NULL
FROM fin_metas WHERE nome = 'Venda de Produtos / Peças';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867718', 'Vendas de produtos', '501360', 'LOCAÇÃO E QUÍMICOS - CM'
FROM fin_metas WHERE nome = 'Químicos';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867719', 'Vendas no balcão', '501360', 'LOCAÇÃO E QUÍMICOS - CM'
FROM fin_metas WHERE nome = 'Químicos';

-- === CUSTOS VARIÁVEIS ===
INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28120514', 'Impostos e taxas', NULL, NULL
FROM fin_metas WHERE nome = 'Impostos (DAS/ISS/IRPJ/CSLL)';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '34135304', 'ISSQN', NULL, NULL
FROM fin_metas WHERE nome = 'Impostos (DAS/ISS/IRPJ/CSLL)';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867687', 'Impostos federais', NULL, NULL
FROM fin_metas WHERE nome = 'Impostos (DAS/ISS/IRPJ/CSLL)';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867704', 'Impostos estaduais', NULL, NULL
FROM fin_metas WHERE nome = 'Impostos (DAS/ISS/IRPJ/CSLL)';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867703', 'Compra de peças e materiais', '501357', 'OPERAÇÕES COZINHAS'
FROM fin_metas WHERE nome = 'Custo com Peças e Estoque';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867703', 'Compra de peças e materiais', '638661', 'OPERAÇÕES COZINHA'
FROM fin_metas WHERE nome = 'Custo com Peças e Estoque';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867703', 'Compra de peças e materiais', '566288', 'OPERAÇÃO CHAMADOS'
FROM fin_metas WHERE nome = 'Custo com Peças e Estoque';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27911903', 'Estoque de peças', '501357', 'OPERAÇÕES COZINHAS'
FROM fin_metas WHERE nome = 'Custo com Peças e Estoque';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28054594', 'Comissões técnicos', '501357', 'OPERAÇÕES COZINHAS'
FROM fin_metas WHERE nome = 'Comissões (Técnicos + Vendedores)';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28054594', 'Comissões técnicos', '638661', 'OPERAÇÕES COZINHA'
FROM fin_metas WHERE nome = 'Comissões (Técnicos + Vendedores)';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28054594', 'Comissões técnicos', '566288', 'OPERAÇÃO CHAMADOS'
FROM fin_metas WHERE nome = 'Comissões (Técnicos + Vendedores)';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867702', 'Comissões vendedores', '501356', 'COMERCIAL'
FROM fin_metas WHERE nome = 'Comissões (Técnicos + Vendedores)';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867667', 'Combustivel', '501357', 'OPERAÇÕES COZINHAS'
FROM fin_metas WHERE nome = 'Combustível';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867667', 'Combustivel', '638661', 'OPERAÇÕES COZINHA'
FROM fin_metas WHERE nome = 'Combustível';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867667', 'Combustivel', '566288', 'OPERAÇÃO CHAMADOS'
FROM fin_metas WHERE nome = 'Combustível';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28034468', 'Manutenção de veículos / IPVA', '506864', 'GALPÃO'
FROM fin_metas WHERE nome = 'Manutenção / IPVA / Seguro Veículos';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28160995', 'Seguro de veículos', '506864', 'GALPÃO'
FROM fin_metas WHERE nome = 'Manutenção / IPVA / Seguro Veículos';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867993', 'Sublocação de máquinas', '501360', 'LOCAÇÃO E QUÍMICOS - CM'
FROM fin_metas WHERE nome = 'Sublocação de Máquinas';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27912040', 'Hospedagem', '501357', 'OPERAÇÕES COZINHAS'
FROM fin_metas WHERE nome = 'Hospedagem';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27912040', 'Hospedagem', '638661', 'OPERAÇÕES COZINHA'
FROM fin_metas WHERE nome = 'Hospedagem';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28160784', 'Pedágio', '501357', 'OPERAÇÕES COZINHAS'
FROM fin_metas WHERE nome = 'Pedágio';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28160784', 'Pedágio', '638661', 'OPERAÇÕES COZINHA'
FROM fin_metas WHERE nome = 'Pedágio';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28160784', 'Pedágio', '566288', 'OPERAÇÃO CHAMADOS'
FROM fin_metas WHERE nome = 'Pedágio';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28223100', 'Estacionamento', '501357', 'OPERAÇÕES COZINHAS'
FROM fin_metas WHERE nome = 'Estacionamento';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28223100', 'Estacionamento', '566288', 'OPERAÇÃO CHAMADOS'
FROM fin_metas WHERE nome = 'Estacionamento';

-- === CUSTOS FIXOS ===
INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867664', 'Aluguel', '506864', 'GALPÃO'
FROM fin_metas WHERE nome = 'Aluguel / Galpão';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867683', 'Energia / Água', '506864', 'GALPÃO'
FROM fin_metas WHERE nome = 'Energia + Água';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867697', 'Internet / Telefonia', '501359', 'ADM'
FROM fin_metas WHERE nome = 'Internet + Telefonia';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867688', 'Sistemas / Software', '501359', 'ADM'
FROM fin_metas WHERE nome = 'Sistemas / Software / NFe';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867669', 'Contabilidade', '501359', 'ADM'
FROM fin_metas WHERE nome = 'Contabilidade';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27942305', 'Consultoria tributária', '501359', 'ADM'
FROM fin_metas WHERE nome = 'Consultoria Tributária';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867694', 'Folha de pagamento ADM', '501359', 'ADM'
FROM fin_metas WHERE nome = 'Folha ADM';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867694', 'Folha de pagamento ADM', '501356', 'COMERCIAL'
FROM fin_metas WHERE nome = 'Folha ADM';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '30893561', 'Folha técnicos', '501357', 'OPERAÇÕES COZINHAS'
FROM fin_metas WHERE nome = 'Folha Técnico';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '30893561', 'Folha técnicos', '638661', 'OPERAÇÕES COZINHA'
FROM fin_metas WHERE nome = 'Folha Técnico';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '30893561', 'Folha técnicos', '566288', 'OPERAÇÃO CHAMADOS'
FROM fin_metas WHERE nome = 'Folha Técnico';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '29155683', 'Pró-Labore', '646260', 'DIRETORIA'
FROM fin_metas WHERE nome = 'Pró-Labore';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867673', 'Empréstimos / Financiamentos', '501359', 'ADM'
FROM fin_metas WHERE nome = 'Empréstimos / Consórcio';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27951677', 'Seguro de vida', '501359', 'ADM'
FROM fin_metas WHERE nome = 'Seguro de Vida Colaboradores';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28160995', 'Seguro de veículos', '506864', 'GALPÃO'
FROM fin_metas WHERE nome = 'Seguro Carros';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867695', 'EPI / Uniformes', '501357', 'OPERAÇÕES COZINHAS'
FROM fin_metas WHERE nome = 'EPI / Uniformes';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867695', 'EPI / Uniformes', '638661', 'OPERAÇÕES COZINHA'
FROM fin_metas WHERE nome = 'EPI / Uniformes';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27983783', 'Refeições', '501357', 'OPERAÇÕES COZINHAS'
FROM fin_metas WHERE nome = 'Refeições';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27983783', 'Refeições', '638661', 'OPERAÇÕES COZINHA'
FROM fin_metas WHERE nome = 'Refeições';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27983783', 'Refeições', '566288', 'OPERAÇÃO CHAMADOS'
FROM fin_metas WHERE nome = 'Refeições';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867688', 'Rastreador veicular', '506864', 'GALPÃO'
FROM fin_metas WHERE nome = 'Rastreador Veicular';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867692', 'Papelaria / escritório', '501359', 'ADM'
FROM fin_metas WHERE nome = 'Papelaria / Escritório';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867696', 'Limpeza / Insumos internos', '501359', 'ADM'
FROM fin_metas WHERE nome = 'Limpeza / Insumos Internos';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28889388', 'Manutenção celular / TI', '501359', 'ADM'
FROM fin_metas WHERE nome = 'Manutenção Celular / TI';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28188241', 'RH / Certificados / Treinamentos', '501359', 'ADM'
FROM fin_metas WHERE nome = 'RH / Certificados / Treinamentos';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28211859', 'Ferramentas / Mobiliário', '501357', 'OPERAÇÕES COZINHAS'
FROM fin_metas WHERE nome = 'Ferramentas / Mobiliário';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28211859', 'Ferramentas / Mobiliário', '638661', 'OPERAÇÕES COZINHA'
FROM fin_metas WHERE nome = 'Ferramentas / Mobiliário';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '27867691', 'Marketing / Publicidade', '501356', 'COMERCIAL'
FROM fin_metas WHERE nome = 'Marketing / Publicidade';

INSERT INTO fin_meta_plano_contas (meta_id, plano_contas_id, nome_plano, centro_custo_id, nome_centro_custo)
SELECT id, '28034468', 'IPVA / Licenciamento veículos', '506864', 'GALPÃO'
FROM fin_metas WHERE nome = 'IPVA (veículos)';
