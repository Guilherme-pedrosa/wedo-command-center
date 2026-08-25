-- ============================================================================
-- Apuração fiscal: PIS/COFINS (não-cumulativo) e ICMS
-- ----------------------------------------------------------------------------
-- Camada NOVA, separada de fin_produto_tributos.
--
-- fin_produto_tributos é UNIQUE(gc_produto_id): guarda a ÚLTIMA NF de cada
-- produto e serve a custeio/precificação. Apuração precisa de razão por
-- competência, com o dado congelado como estava na nota. São modelos
-- incompatíveis — por isso tabelas próprias com prefixo fis_.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Regras de CFOP — auditáveis em tabela, não hardcoded no código
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fis_cfop_regra (
  cfop                    text PRIMARY KEY,
  descricao               text NOT NULL,
  sentido                 text NOT NULL CHECK (sentido IN ('entrada','saida')),
  -- Saídas: entra na base de cálculo do débito de PIS/COFINS?
  compoe_receita          boolean NOT NULL DEFAULT true,
  -- Entradas: CFOP admite crédito? (a decisão final ainda depende do CST/CRT)
  gera_credito_piscofins  boolean NOT NULL DEFAULT false,
  gera_credito_icms       boolean NOT NULL DEFAULT false,
  observacao              text,
  atualizado_em           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fis_cfop_regra IS
  'Classificação de CFOP usada na apuração. Editável pelo fiscal sem deploy.';

-- Saídas que NÃO são receita (Regra 1.3 do fechamento)
INSERT INTO public.fis_cfop_regra (cfop, descricao, sentido, compoe_receita, observacao) VALUES
  ('5202','Devolução de compra para comercialização','saida',false,'Regra 1.3 - devolução de compra'),
  ('6202','Devolução de compra para comercialização (interestadual)','saida',false,'Regra 1.3 - devolução de compra'),
  ('5556','Devolução de compra de material de uso ou consumo','saida',false,'Regra 1.3 - devolução de compra'),
  ('6556','Devolução de compra de material de uso ou consumo (interestadual)','saida',false,'Regra 1.3 - devolução de compra'),
  ('5910','Remessa em bonificação, doação ou brinde','saida',false,'Regra 1.3 - bonificação/brinde'),
  ('6910','Remessa em bonificação, doação ou brinde (interestadual)','saida',false,'Regra 1.3 - bonificação/brinde'),
  ('5913','Retorno de remessa em garantia','saida',false,'Regra 1.3 - retorno de garantia'),
  ('6913','Retorno de remessa em garantia (interestadual)','saida',false,'Regra 1.3 - retorno de garantia'),
  ('5920','Remessa para conserto ou garantia','saida',false,'Remessa - não é receita'),
  ('6920','Remessa para conserto ou garantia (interestadual)','saida',false,'Remessa - não é receita'),
  ('5949','Outra saída não especificada','saida',false,'Conferir caso a caso - default conservador'),
  ('6949','Outra saída não especificada (interestadual)','saida',false,'Conferir caso a caso - default conservador')
ON CONFLICT (cfop) DO NOTHING;

-- Saídas que SÃO receita
INSERT INTO public.fis_cfop_regra (cfop, descricao, sentido, compoe_receita) VALUES
  ('5101','Venda de produção do estabelecimento','saida',true),
  ('6101','Venda de produção do estabelecimento (interestadual)','saida',true),
  ('5102','Venda de mercadoria adquirida ou recebida de terceiros','saida',true),
  ('6102','Venda de mercadoria adquirida ou recebida de terceiros (interestadual)','saida',true),
  ('5405','Venda de mercadoria sujeita a ST na condicao de substituido','saida',true),
  ('6404','Venda de mercadoria sujeita a ST (interestadual)','saida',true),
  ('5933','Prestacao de servico tributado pelo ISSQN','saida',true)
ON CONFLICT (cfop) DO NOTHING;

-- Entradas que admitem crédito (Regra 2.2)
INSERT INTO public.fis_cfop_regra (cfop, descricao, sentido, compoe_receita, gera_credito_piscofins, gera_credito_icms) VALUES
  ('1101','Compra para industrializacao','entrada',false,true,true),
  ('2101','Compra para industrializacao (interestadual)','entrada',false,true,true),
  ('1102','Compra para comercializacao','entrada',false,true,true),
  ('2102','Compra para comercializacao (interestadual)','entrada',false,true,true),
  ('1403','Compra para comercializacao em operacao com ST','entrada',false,true,false),
  ('2403','Compra para comercializacao em operacao com ST (interestadual)','entrada',false,true,false),
  ('1126','Compra para utilizacao na prestacao de servico','entrada',false,true,true),
  ('2126','Compra para utilizacao na prestacao de servico (interestadual)','entrada',false,true,true),
  ('1556','Compra de material para uso ou consumo','entrada',false,false,false),
  ('2556','Compra de material para uso ou consumo (interestadual)','entrada',false,false,false)
ON CONFLICT (cfop) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Notas de SAÍDA (origem: API do GestãoClick)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fis_nf_saida (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gc_id               text NOT NULL,
  modelo              text NOT NULL CHECK (modelo IN ('55','65','NFSE')),
  numero              text,
  serie               text,
  chave               text,
  protocolo           text,

  data_emissao        date NOT NULL,
  competencia         date NOT NULL,          -- primeiro dia do mês de emissão

  situacao_nf         text,
  autorizada          boolean NOT NULL DEFAULT false,
  cancelada           boolean NOT NULL DEFAULT false,
  denegada            boolean NOT NULL DEFAULT false,

  natureza_operacao   text,
  codigo_cfop         text,
  descricao_cfop      text,

  destinatario_nome   text,
  destinatario_doc    text,
  destinatario_uf     text,
  destinatario_ie     text,
  consumidor_final    boolean,

  valor_produtos      numeric(14,2) DEFAULT 0,
  valor_servico       numeric(14,2) DEFAULT 0,
  valor_desconto      numeric(14,2) DEFAULT 0,
  valor_frete         numeric(14,2) DEFAULT 0,
  valor_total_nf      numeric(14,2) DEFAULT 0,

  base_icms           numeric(14,2) DEFAULT 0,
  valor_icms          numeric(14,2) DEFAULT 0,
  base_icms_st        numeric(14,2) DEFAULT 0,
  valor_icms_st       numeric(14,2) DEFAULT 0,
  valor_fcp           numeric(14,2) DEFAULT 0,
  valor_fcp_st        numeric(14,2) DEFAULT 0,
  valor_ipi           numeric(14,2) DEFAULT 0,
  valor_pis           numeric(14,2) DEFAULT 0,
  valor_cofins        numeric(14,2) DEFAULT 0,

  -- Bloco exclusivo de NFS-e: retenções na fonte declaradas na nota
  valor_base_calculo  numeric(14,2),
  pis_retido          boolean DEFAULT false,
  cofins_retido       boolean DEFAULT false,
  csll_retido         boolean DEFAULT false,
  ir_retido           boolean DEFAULT false,
  inss_retido         boolean DEFAULT false,
  iss_retido          boolean DEFAULT false,
  valor_iss           numeric(14,2) DEFAULT 0,
  valor_ir            numeric(14,2) DEFAULT 0,
  valor_csll          numeric(14,2) DEFAULT 0,
  valor_inss          numeric(14,2) DEFAULT 0,

  gc_payload_raw      jsonb,
  last_synced_at      timestamptz DEFAULT now(),
  created_at          timestamptz DEFAULT now(),
  UNIQUE (modelo, gc_id)
);

CREATE INDEX IF NOT EXISTS idx_fis_nf_saida_competencia ON public.fis_nf_saida (competencia);
CREATE INDEX IF NOT EXISTS idx_fis_nf_saida_cfop        ON public.fis_nf_saida (codigo_cfop);
CREATE INDEX IF NOT EXISTS idx_fis_nf_saida_chave       ON public.fis_nf_saida (chave);

CREATE TABLE IF NOT EXISTS public.fis_nf_saida_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nf_saida_id     uuid NOT NULL REFERENCES public.fis_nf_saida(id) ON DELETE CASCADE,
  ordem           int NOT NULL DEFAULT 0,
  produto_gc_id   text,
  codigo_produto  text,
  nome_produto    text,
  cfop            text,
  ncm             text,
  unidade         text,
  quantidade      numeric(14,4) DEFAULT 0,
  valor_venda     numeric(14,2) DEFAULT 0,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fis_nf_saida_item_nf ON public.fis_nf_saida_item (nf_saida_id);

-- ---------------------------------------------------------------------------
-- 3. Notas de ENTRADA (origem: XML no Storage, reparseado item a item)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fis_nf_entrada (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chave              text NOT NULL UNIQUE,
  modelo             text,
  numero             text,
  serie              text,

  cnpj_emitente      text,
  nome_emitente      text,
  uf_emitente        text,
  -- CRT do emitente: 1 = Simples Nacional, 2 = Simples excesso sublimite,
  -- 3 = Regime Normal, 4 = MEI. Base da "regra de resgate" (Regra 2.4).
  crt_emitente       smallint,
  regime_emitente    text GENERATED ALWAYS AS (
                        CASE crt_emitente
                          WHEN 1 THEN 'simples_nacional'
                          WHEN 2 THEN 'simples_nacional'
                          WHEN 4 THEN 'mei'
                          WHEN 3 THEN 'regime_normal'
                          ELSE 'desconhecido'
                        END
                      ) STORED,

  natureza_operacao  text,
  data_emissao       date NOT NULL,
  competencia        date NOT NULL,

  valor_produtos     numeric(14,2) DEFAULT 0,
  valor_frete        numeric(14,2) DEFAULT 0,
  valor_desconto     numeric(14,2) DEFAULT 0,
  valor_ipi          numeric(14,2) DEFAULT 0,
  valor_icms         numeric(14,2) DEFAULT 0,
  valor_icms_st      numeric(14,2) DEFAULT 0,
  valor_total        numeric(14,2) DEFAULT 0,

  storage_path       text,
  gc_compra_id       text,
  parsed_at          timestamptz DEFAULT now(),
  created_at         timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fis_nf_entrada_competencia ON public.fis_nf_entrada (competencia);
CREATE INDEX IF NOT EXISTS idx_fis_nf_entrada_crt         ON public.fis_nf_entrada (crt_emitente);

CREATE TABLE IF NOT EXISTS public.fis_nf_entrada_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nf_entrada_id     uuid NOT NULL REFERENCES public.fis_nf_entrada(id) ON DELETE CASCADE,
  ordem             int NOT NULL DEFAULT 0,

  codigo_produto    text,
  nome_produto      text,
  ncm               text,
  cfop              text,
  unidade           text,
  quantidade        numeric(14,4) DEFAULT 0,
  valor_produto     numeric(14,2) DEFAULT 0,
  valor_frete       numeric(14,2) DEFAULT 0,
  valor_desconto    numeric(14,2) DEFAULT 0,
  valor_ipi         numeric(14,2) DEFAULT 0,

  -- ATENÇÃO: o XML de entrada carrega o CST de SAÍDA do fornecedor
  -- (01, 02, 04, 05, 06, 07, 08, 49, 99), porque para ele a operação é saída.
  -- É esse código que a Regra 2.3 avalia.
  cst_pis           text,
  cst_cofins        text,
  cst_icms          text,   -- CST ICMS (regime normal) ou CSOSN (Simples)
  origem_mercadoria text,   -- tag <orig>: 0 nacional, 1-2 importada, ...

  base_pis          numeric(14,2) DEFAULT 0,
  aliq_pis          numeric(9,4)  DEFAULT 0,
  valor_pis         numeric(14,2) DEFAULT 0,
  base_cofins       numeric(14,2) DEFAULT 0,
  aliq_cofins       numeric(9,4)  DEFAULT 0,
  valor_cofins      numeric(14,2) DEFAULT 0,
  base_icms         numeric(14,2) DEFAULT 0,
  aliq_icms         numeric(9,4)  DEFAULT 0,
  valor_icms        numeric(14,2) DEFAULT 0,
  -- Redução de base: sem isto o crédito de ICMS sai inflado.
  perc_reducao_bc   numeric(9,4)  DEFAULT 0,
  valor_icms_st     numeric(14,2) DEFAULT 0,
  valor_fcp_st      numeric(14,2) DEFAULT 0,
  -- DIFAL (EC 87/2015) — obrigatório na apuração interestadual.
  valor_difal_dest  numeric(14,2) DEFAULT 0,
  valor_difal_remet numeric(14,2) DEFAULT 0,

  -- Decisão de crédito, gravada com o motivo para rastro de auditoria
  credito_piscofins_permitido boolean NOT NULL DEFAULT false,
  credito_piscofins_base      numeric(14,2) NOT NULL DEFAULT 0,
  credito_icms_permitido      boolean NOT NULL DEFAULT false,
  credito_icms_valor          numeric(14,2) NOT NULL DEFAULT 0,
  motivo_decisao              text,
  regra_aplicada              text,

  created_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fis_nf_entrada_item_nf   ON public.fis_nf_entrada_item (nf_entrada_id);
CREATE INDEX IF NOT EXISTS idx_fis_nf_entrada_item_cfop ON public.fis_nf_entrada_item (cfop);

-- ---------------------------------------------------------------------------
-- 4. Retenções na fonte (CSRF) — regime de CAIXA (Regra 3)
-- ---------------------------------------------------------------------------
-- A NFS-e informa a retenção na EMISSÃO; a guia deduz na LIQUIDAÇÃO.
-- Esta tabela é a ponte: o valor vem da nota, a competência vem da baixa.
CREATE TABLE IF NOT EXISTS public.fis_retencao (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competencia         date NOT NULL,          -- derivada de data_liquidacao
  nf_saida_id         uuid REFERENCES public.fis_nf_saida(id) ON DELETE SET NULL,
  recebimento_id      uuid REFERENCES public.fin_recebimentos(id) ON DELETE SET NULL,

  nf_numero           text,
  nome_cliente        text,
  data_liquidacao     date NOT NULL,
  valor_base          numeric(14,2) NOT NULL DEFAULT 0,
  valor_pis_retido    numeric(14,2) NOT NULL DEFAULT 0,
  valor_cofins_retido numeric(14,2) NOT NULL DEFAULT 0,

  origem              text NOT NULL DEFAULT 'nfse' CHECK (origem IN ('nfse','manual','importacao')),
  observacao          text,
  created_by          text,
  created_at          timestamptz DEFAULT now(),
  UNIQUE (nf_saida_id, recebimento_id)
);

CREATE INDEX IF NOT EXISTS idx_fis_retencao_competencia ON public.fis_retencao (competencia);

-- ---------------------------------------------------------------------------
-- 5. Resultado da apuração por competência e tributo
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fis_apuracao (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competencia            date NOT NULL,
  tributo                text NOT NULL CHECK (tributo IN ('PIS','COFINS','ICMS')),

  receita_bruta          numeric(14,2) NOT NULL DEFAULT 0,
  base_debito            numeric(14,2) NOT NULL DEFAULT 0,
  aliquota               numeric(9,4)  NOT NULL DEFAULT 0,
  valor_debito           numeric(14,2) NOT NULL DEFAULT 0,

  base_credito           numeric(14,2) NOT NULL DEFAULT 0,
  base_credito_simples   numeric(14,2) NOT NULL DEFAULT 0,  -- fração resgatada (Regra 2.4)
  valor_credito          numeric(14,2) NOT NULL DEFAULT 0,

  valor_retencoes        numeric(14,2) NOT NULL DEFAULT 0,
  saldo_credor_anterior  numeric(14,2) NOT NULL DEFAULT 0,

  saldo_a_recolher       numeric(14,2) NOT NULL DEFAULT 0,
  saldo_credor_proximo   numeric(14,2) NOT NULL DEFAULT 0,

  status                 text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','fechada')),
  detalhamento           jsonb,
  calculado_em           timestamptz DEFAULT now(),
  fechada_em             timestamptz,
  fechada_por            text,
  UNIQUE (competencia, tributo)
);

COMMENT ON COLUMN public.fis_apuracao.saldo_a_recolher IS
  'Debito - Credito - Retencoes - Saldo credor anterior. Nunca negativo: o excedente vai para saldo_credor_proximo.';

-- ---------------------------------------------------------------------------
-- 6. Anomalias — o "Alerta de Anomalias" do output exigido
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fis_anomalia (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competencia   date NOT NULL,
  tipo          text NOT NULL,
  severidade    text NOT NULL DEFAULT 'aviso' CHECK (severidade IN ('info','aviso','critico')),
  referencia    text,          -- chave da NF-e, gc_id ou storage_path
  descricao     text NOT NULL,
  contexto      jsonb,
  resolvida     boolean NOT NULL DEFAULT false,
  resolvida_em  timestamptz,
  resolvida_por text,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fis_anomalia_competencia ON public.fis_anomalia (competencia, resolvida);

-- ---------------------------------------------------------------------------
-- 7. Configurações usadas pela apuração
-- ---------------------------------------------------------------------------
INSERT INTO public.fin_configuracoes (chave, valor, descricao) VALUES
  ('CNPJ_EMPRESA', '',
   'CNPJ da empresa, só dígitos. Usado por fis-parse-entrada para descartar do lote de ENTRADAS as notas emitidas pela própria empresa. Enquanto vazio, esse descarte não acontece.'),
  ('FISCAL_INCLUIR_FRETE_NA_BASE_CREDITO', 'false',
   'Inclui o frete rateado na base do crédito de PIS/COFINS. Default false: a regra de negócio fala em "valor dos produtos". Alinhar com a contabilidade antes de ligar.')
ON CONFLICT (chave) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. RLS — dado fiscal é restrito a admin / CEO / gerente financeiro
-- ---------------------------------------------------------------------------
ALTER TABLE public.fis_cfop_regra       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fis_nf_saida         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fis_nf_saida_item    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fis_nf_entrada       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fis_nf_entrada_item  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fis_retencao         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fis_apuracao         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fis_anomalia         ENABLE ROW LEVEL SECURITY;

DO $policies$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fis_cfop_regra','fis_nf_saida','fis_nf_saida_item','fis_nf_entrada',
    'fis_nf_entrada_item','fis_retencao','fis_apuracao','fis_anomalia'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (%s) WITH CHECK (%s)',
      'fiscal_rw_' || t,
      t,
      'public.has_role(auth.uid(), ''admin'') OR public.has_role(auth.uid(), ''ceo'') OR public.has_role(auth.uid(), ''gerente_financeiro'')',
      'public.has_role(auth.uid(), ''admin'') OR public.has_role(auth.uid(), ''ceo'') OR public.has_role(auth.uid(), ''gerente_financeiro'')'
    );
  END LOOP;
END
$policies$;
