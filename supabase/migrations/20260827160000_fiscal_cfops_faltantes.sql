-- ============================================================================
-- CFOPs que apareciam nos XMLs e nao existiam na tabela de regras.
--
-- Item com CFOP nao cadastrado caia em "classificar antes de fechar" e ficava
-- sem credito. Varrendo todos os documentos ja importados, oito CFOPs estavam
-- nessa situacao.
--
-- O maior deles merece atencao: 6923, remessa por conta e ordem em venda a
-- ordem, com 195 itens e R$ 81.493,16 de uma unica fornecedora. NAO gera
-- credito de proposito -- nessa operacao chegam duas notas pela mesma
-- mercadoria, a remessa de quem entrega e a venda de quem vendeu. O credito
-- esta na nota de venda. Creditar a remessa contaria a mesma compra duas
-- vezes.
-- ============================================================================

INSERT INTO public.fis_cfop_regra
  (cfop, descricao, sentido, compoe_receita, gera_credito_piscofins, gera_credito_icms, observacao)
VALUES
  ('5107','Venda de producao a nao contribuinte','saida',true,true,true,
   'Entrada: aquisicao para a operacao. O enquadramento do destinatario nao muda a natureza da compra.'),
  ('6107','Venda de producao a nao contribuinte (interestadual)','saida',true,true,true,
   'Entrada: aquisicao para a operacao. O enquadramento do destinatario nao muda a natureza da compra.'),
  ('5105','Venda de producao que nao deva transitar pelo estabelecimento','saida',true,true,true,
   'Entrada: aquisicao para a operacao.'),
  ('6105','Venda de producao que nao deva transitar (interestadual)','saida',true,true,true,
   'Entrada: aquisicao para a operacao.'),

  ('5655','Venda de combustivel/lubrificante de terceiros para consumidor','saida',true,true,false,
   'Combustivel/lubrificante consumido na operacao. Art. 3o, II da Lei 10.833/2003 nomeia combustiveis e lubrificantes como insumo. ICMS retido por ST na cadeia.'),
  ('6655','Venda de combustivel/lubrificante para consumidor (interestadual)','saida',true,true,false,
   'Combustivel/lubrificante consumido na operacao.'),
  ('5656','Venda de combustivel/lubrificante de terceiros para consumidor','saida',true,true,false,
   'Combustivel/lubrificante consumido na operacao.'),
  ('6656','Venda de combustivel/lubrificante para consumidor (interestadual)','saida',true,true,false,
   'Combustivel/lubrificante consumido na operacao.'),
  ('5667','Venda de combustivel/lubrificante a consumidor final','saida',true,true,false,
   'Combustivel/lubrificante consumido na operacao.'),
  ('6667','Venda de combustivel/lubrificante a consumidor final (interestadual)','saida',true,true,false,
   'Combustivel/lubrificante consumido na operacao.'),
  ('1652','Compra de combustivel/lubrificante para comercializacao','entrada',false,true,false,
   'Combustivel adquirido. ICMS retido por ST na cadeia.'),
  ('1662','Compra de combustivel/lubrificante para consumo','entrada',false,true,false,
   'Combustivel consumido na operacao. Art. 3o, II da Lei 10.833/2003.'),
  ('2662','Compra de combustivel/lubrificante para consumo (interestadual)','entrada',false,true,false,
   'Combustivel consumido na operacao.'),

  ('5923','Remessa por conta e ordem de terceiros, em venda a ordem','saida',false,false,false,
   'Remessa em venda a ordem. Nao e aquisicao: o credito esta na nota de venda do vendedor. Creditar aqui duplicaria a mesma mercadoria.'),
  ('6923','Remessa por conta e ordem de terceiros, em venda a ordem (interestadual)','saida',false,false,false,
   'Remessa em venda a ordem. Nao e aquisicao: o credito esta na nota de venda do vendedor. Creditar aqui duplicaria a mesma mercadoria.'),

  ('1202','Devolucao de venda de mercadoria de terceiros','entrada',false,false,false,
   'Devolucao, nao e aquisicao.'),
  ('2202','Devolucao de venda de mercadoria de terceiros (interestadual)','entrada',false,false,false,
   'Devolucao, nao e aquisicao.')
ON CONFLICT (cfop) DO UPDATE SET
  gera_credito_piscofins = EXCLUDED.gera_credito_piscofins,
  gera_credito_icms      = EXCLUDED.gera_credito_icms,
  observacao             = EXCLUDED.observacao,
  atualizado_em          = now();
