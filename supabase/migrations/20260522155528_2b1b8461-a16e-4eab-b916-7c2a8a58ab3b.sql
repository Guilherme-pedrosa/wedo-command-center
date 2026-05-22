ALTER TABLE public.fin_politica_markup_tabela
  DROP CONSTRAINT IF EXISTS fin_politica_markup_tabela_modo_sugestao_check;

ALTER TABLE public.fin_politica_markup_tabela
  ADD CONSTRAINT fin_politica_markup_tabela_modo_sugestao_check
  CHECK (modo_sugestao IN ('sugerir', 'automatico', 'manual', 'manual_only'));

DELETE FROM public.fin_politica_markup_tabela;

INSERT INTO public.fin_politica_markup_tabela
  (tipo_id, nome_tabela, margem_minima, modo_sugestao, exige_aprovacao_ceo)
VALUES
  ('509609', 'Tabela A - (Sodexo, GR, CLIENTES A PRAZO)', 0.30, 'sugerir', false),
  ('509605', 'Tabela B (Consumidor Final, PAG a Vista)', 0.20, 'sugerir', false),
  ('509606', 'TABELA P', 0.15, 'sugerir', false),
  ('509604', 'Tabela V (Acima de 500km)', 0.30, 'sugerir', false),
  ('576894', 'TABELA COMERCIAL ACESSÓRIOS', 0.15, 'sugerir', false),
  ('585751', 'TABELA SAPORE / JBS', 0.35, 'manual', true),
  ('590124', 'TABELA RATIONAL A', 0.22, 'sugerir', false),
  ('596111', 'TABELA RATIONAL B', 0.18, 'sugerir', true),
  ('596109', 'TABELA RATIONAL - GUERRA', 0.12, 'manual', true),
  ('596115', 'TABELA EQUIPAMENTOS A (EXCETO RATIONAL)', 0.25, 'sugerir', false),
  ('596116', 'TABELA EQUIPAMENTOS B (EXCETO RATIONAL)', 0.20, 'sugerir', true),
  ('596118', 'TABELA EQUIPAMENTOS P (EXCETO RATIONAL)', 0.15, 'manual', true);

INSERT INTO public.fin_configuracoes (chave, valor)
VALUES
  ('ENABLE_GC_WRITE', 'false'),
  ('NOTIFICATION_EMAIL', 'guilherme@wedocorp.com'),
  ('NOTIFICATION_WHATSAPP', ''),
  ('TRIB_SAIDA_VENDA_TOTAL', '0.1805'),
  ('TRIB_SAIDA_SERVICO_TOTAL', '0.1325'),
  ('TRIB_SAIDA_ICMS', '0.088'),
  ('TRIB_SAIDA_PIS', '0.0165'),
  ('TRIB_SAIDA_COFINS', '0.076'),
  ('TRIB_SAIDA_ISS', '0.05'),
  ('AUTO_PUT_LIMITE_HORA', '50'),
  ('AUTO_PUT_LIMITE_DIA', '500'),
  ('AUTO_PUT_LIMITE_VALOR_UNICO', '1000'),
  ('SYNC_GC_PRODUTOS_INTERVALO_MIN', '30'),
  ('LAST_SYNC_GC_PRODUTOS_PAGE', '0'),
  ('LAST_SYNC_GC_PRODUTOS_COMPLETED_AT', ''),
  ('SYNC_GC_PRODUTOS_TIMEOUT_SEGUNDOS', '25')
ON CONFLICT (chave) DO NOTHING;

ALTER TABLE public.fin_produto_tributos
  ADD COLUMN IF NOT EXISTS u_com numeric,
  ADD COLUMN IF NOT EXISTS q_com numeric,
  ADD COLUMN IF NOT EXISTS v_un_com numeric,
  ADD COLUMN IF NOT EXISTS u_trib numeric,
  ADD COLUMN IF NOT EXISTS q_trib numeric,
  ADD COLUMN IF NOT EXISTS v_un_trib numeric,
  ADD COLUMN IF NOT EXISTS fator_conversao numeric,
  ADD COLUMN IF NOT EXISTS v_seg numeric,
  ADD COLUMN IF NOT EXISTS v_outro numeric,
  ADD COLUMN IF NOT EXISTS v_desc numeric,
  ADD COLUMN IF NOT EXISTS v_icms_st numeric,
  ADD COLUMN IF NOT EXISTS v_fcp_st numeric,
  ADD COLUMN IF NOT EXISTS v_icms_uf_dest numeric,
  ADD COLUMN IF NOT EXISTS v_icms_uf_remet numeric,
  ADD COLUMN IF NOT EXISTS custo_variavel_real numeric;