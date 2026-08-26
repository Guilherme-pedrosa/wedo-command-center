-- ============================================================================
-- Correção de raiz: o CFOP que chega no XML de compra é o de SAÍDA do
-- FORNECEDOR (5xxx/6xxx), não o de entrada do adquirente (1xxx/2xxx).
--
-- A carga original de fis_cfop_regra só classificava 1101/1102/2101/2102 como
-- geradores de crédito. Como esses códigos nunca aparecem no XML recebido, a
-- apuração negava crédito em 100% dos itens — 421 de 421 em julho/2026.
--
-- Aqui os CFOPs de saída do fornecedor passam a carregar, além do papel que já
-- tinham nas NOSSAS saídas (compoe_receita), o efeito que produzem quando a
-- nota é lida como ENTRADA (gera_credito_*). Mesma linha, dois contextos
-- independentes: compoe_receita é lido na apuração do débito, gera_credito_*
-- na apuração do crédito.
--
-- ICMS e PIS/COFINS são decididos em separado. Mercadoria com substituição
-- tributária gera crédito de PIS/COFINS mas não de ICMS, porque o ICMS já foi
-- retido na cadeia.
-- ============================================================================

INSERT INTO public.fis_cfop_regra
  (cfop, descricao, sentido, compoe_receita, gera_credito_piscofins, gera_credito_icms, observacao)
VALUES
  -- Aquisição de insumo / produção
  ('5101','Venda de producao do estabelecimento','saida',true,true,true,
   'Entrada: insumo/producao - credita PIS/COFINS e ICMS'),
  ('6101','Venda de producao (interestadual)','saida',true,true,true,
   'Entrada: insumo/producao - credita PIS/COFINS e ICMS'),

  -- Aquisição para revenda / aplicação em serviço
  ('5102','Venda de mercadoria de terceiros','saida',true,true,true,
   'Entrada: revenda/insumo - credita PIS/COFINS e ICMS'),
  ('6102','Venda de mercadoria de terceiros (interestadual)','saida',true,true,true,
   'Entrada: revenda/insumo - credita PIS/COFINS e ICMS'),
  ('6106','Venda de mercadoria para entrega futura','saida',true,true,true,
   'Entrada: revenda - credita PIS/COFINS e ICMS'),
  ('6108','Venda de mercadoria a nao contribuinte','saida',true,true,true,
   'Entrada: revenda - credita PIS/COFINS e ICMS'),

  -- Substituição tributária: PIS/COFINS sim, ICMS não
  ('5405','Venda de mercadoria com ST (substituido)','saida',true,true,false,
   'ST: credita PIS/COFINS, ICMS ja retido na cadeia'),
  ('6403','Venda de mercadoria com ST (interestadual)','saida',true,true,false,
   'ST: credita PIS/COFINS, ICMS ja retido na cadeia'),
  ('6404','Venda de mercadoria com ST (interestadual)','saida',true,true,false,
   'ST: credita PIS/COFINS, ICMS ja retido na cadeia'),

  -- Serviço tomado como insumo: não há ICMS em serviço
  ('5933','Prestacao de servico tributado pelo ISSQN','saida',true,true,false,
   'Servico tomado como insumo: credita PIS/COFINS; servico nao tem ICMS'),

  -- Trânsito: não houve aquisição, nada a creditar
  ('1915','Entrada para conserto ou reparo','entrada',false,false,false,
   'Transito, nao e aquisicao'),
  ('2915','Entrada para conserto ou reparo (interestadual)','entrada',false,false,false,
   'Transito, nao e aquisicao'),
  ('5915','Remessa para conserto ou reparo','saida',false,false,false,
   'Transito, nao e aquisicao'),
  ('6915','Remessa para conserto ou reparo (interestadual)','saida',false,false,false,
   'Transito, nao e aquisicao'),
  ('6916','Retorno de conserto ou reparo (interestadual)','saida',false,false,false,
   'Transito, nao e aquisicao'),

  -- Lançamento espelho de cupom fiscal: duplicidade contábil, não é aquisição
  ('5929','Lancamento espelho de cupom fiscal (ECF)','saida',false,false,false,
   'Duplicidade contabil do ECF, nao e aquisicao'),
  ('6929','Lancamento espelho de cupom fiscal (ECF, interestadual)','saida',false,false,false,
   'Duplicidade contabil do ECF, nao e aquisicao'),

  -- Uso e consumo
  ('5556','Devolucao de compra de material de uso ou consumo','saida',false,false,false,
   'Uso e consumo nao gera credito'),
  ('6556','Devolucao de compra de uso ou consumo (interestadual)','saida',false,false,false,
   'Uso e consumo nao gera credito')
ON CONFLICT (cfop) DO UPDATE SET
  gera_credito_piscofins = EXCLUDED.gera_credito_piscofins,
  gera_credito_icms      = EXCLUDED.gera_credito_icms,
  observacao             = EXCLUDED.observacao,
  atualizado_em          = now();

-- ---------------------------------------------------------------------------
-- O GestãoClick devolve numero_nfe no payload da compra, mas o sync nunca
-- extraía o campo: 185 das 195 compras de julho/2026 tinham o número da nota
-- no JSON e apenas 3 na coluna. É esse vínculo que prova que o item foi
-- adquirido para uso na operação — critério objetivo de insumo, no lugar de
-- depender do CST que o fornecedor digitou.
-- ---------------------------------------------------------------------------
UPDATE public.gc_compras
SET numero_nfe = nullif(trim(gc_payload_raw->'Compra'->>'numero_nfe'),'')
WHERE coalesce(numero_nfe,'') = ''
  AND nullif(trim(gc_payload_raw->'Compra'->>'numero_nfe'),'') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gc_compras_numero_nfe
  ON public.gc_compras (numero_nfe)
  WHERE numero_nfe IS NOT NULL;
