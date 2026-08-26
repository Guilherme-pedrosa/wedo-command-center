-- ============================================================================
-- Classificação de serviço tomado como insumo.
--
-- O CFOP 5933 diz que houve prestação de serviço, não que aquele serviço é
-- insumo. O direito ao crédito depende de essencialidade e relevância para a
-- atividade (Lei 10.833/2003, art. 3º, II; STJ REsp 1.221.170/PR, repetitivo).
--
-- Sem essa camada, entravam na base de crédito de julho/2026: alimentação,
-- comissão de venda, treinamento comercial, hospedagem, passagem aérea,
-- serviços administrativos e um lançamento descrito como "referente a
-- salário" — R$ 56.178,77 que não sobrevivem a uma fiscalização.
--
-- Regra de menor prioridade é avaliada primeiro, de propósito: uma descrição
-- como "almoço durante a manutenção" precisa cair em alimentação, não em
-- manutenção. Sem correspondência, NÃO credita e o item vira anomalia — o
-- caminho auditável é cobrar descrição decente do prestador ou cadastrar a
-- regra aqui, nunca creditar no escuro.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.fis_servico_regra (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  padrao      text NOT NULL,
  credita     boolean NOT NULL,
  categoria   text NOT NULL,
  fundamento  text NOT NULL,
  prioridade  int NOT NULL DEFAULT 100,
  ativo       boolean NOT NULL DEFAULT true,
  criado_em   timestamptz DEFAULT now()
);

COMMENT ON TABLE public.fis_servico_regra IS
  'Classificacao de servico tomado como insumo. Menor prioridade e avaliada primeiro. Sem correspondencia, nao credita.';

INSERT INTO public.fis_servico_regra (padrao, credita, categoria, fundamento, prioridade) VALUES
  -- Vedações primeiro
  ('aliment|alimenc|comida|almo[çc]o|refei[çc][ãa]o|janta|lanche|caf[ée] da manh[ãa]', false,
   'alimentacao', 'Despesa com pessoal, nao insumo. Lei 10.833/2003 art. 3o nao alcanca alimentacao.', 10),
  ('anivers[áa]rio|confraterniza|festa', false,
   'confraternizacao', 'Despesa nao operacional, sem relacao com o processo produtivo.', 10),
  ('comiss[ãa]o|cofcia', false,
   'comissao_venda', 'Despesa comercial pos-venda. Nao integra a prestacao (REsp 1.221.170/PR).', 15),
  ('sal[áa]rio|pr[óo]-labore|pro labore|f[ée]rias|13o|decimo terceiro', false,
   'folha', 'Remuneracao nao gera credito. Lei 10.833/2003 art. 3o par. 2o I.', 15),
  ('premia[çc][ãa]o|b[ôo]nus|gratifica', false,
   'premiacao', 'Remuneracao variavel, nao insumo. Lei 10.833/2003 art. 3o par. 2o I.', 15),
  ('treinamento|instru[çc][ãa]o|curso|capacita', false,
   'treinamento', 'Capacitacao comercial nao e insumo do servico prestado.', 20),
  ('propaganda|publicidade|marketing', false,
   'marketing', 'Despesa comercial, nao insumo.', 20),
  ('hospedagem|hot[ée]l|passagem|a[ée]re[oa]|viagem|di[áa]ria', false,
   'viagem', 'Despesa de viagem nao integra o processo produtivo.', 20),
  ('vendedor|venda de m[áa]quina', false,
   'comissao_venda', 'Atividade comercial pos-producao, nao insumo.', 20),
  ('administrativ|contab|jur[íi]dic|advocac', false,
   'administrativo', 'Atividade-meio. Nao e insumo do servico prestado ao cliente.', 25),
  ('medicina do trabalho|exame|audiometr|acuidade|aso\b', false,
   'saude_ocupacional', 'Obrigacao trabalhista, nao insumo.', 25),
  ('reembolso|ressarcimento|por conta e ordem', false,
   'reembolso', 'Reembolso nao e aquisicao de bem ou servico.', 25),
  ('representa[çc][ãa]o', false,
   'representacao', 'Despesa de representacao, vedada.', 25),

  -- Insumo: núcleo da atividade (equipamento industrial de cozinha)
  ('manuten[çc][ãa]o|manuten[çc]ao', true,
   'manutencao', 'Servico aplicado no equipamento objeto da atividade. Insumo por essencialidade (REsp 1.221.170/PR).', 50),
  ('instala[çc][ãa]o|montagem', true,
   'instalacao', 'Etapa da prestacao contratada ao cliente. Insumo.', 50),
  ('conserto|repara[çc][ãa]o|reparo|rebobinamento|retifica', true,
   'conserto', 'Recuperacao de equipamento aplicado na operacao. Insumo.', 50),
  ('frete|transporte|munck|descarga|carreto', true,
   'frete', 'Frete sobre aquisicao integra o custo do insumo. Lei 10.833/2003 art. 3o.', 55),
  ('t[ée]cnic[oa] de manuten|assist[êe]ncia t[ée]cnica', true,
   'tecnico', 'Mao de obra tecnica aplicada no equipamento. Insumo.', 55),
  ('lavagem|limpeza|higieniza', true,
   'servico_campo', 'Servico executado no equipamento do cliente: e a propria prestacao contratada. Insumo direto.', 55),
  ('emergencial|servi[çc]o d[ao] |servi[çc]oes ', true,
   'servico_campo', 'Atendimento em campo subcontratado, integra a prestacao vendida. Insumo direto.', 58),
  ('software|assinatura.*service|auvo|sistema de gest[ãa]o', true,
   'software_operacional', 'Sistema que operacionaliza a execucao em campo. Insumo por relevancia.', 60)
ON CONFLICT DO NOTHING;

ALTER TABLE public.fis_servico_regra ENABLE ROW LEVEL SECURITY;

DO $p$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='fis_servico_regra'
      AND policyname='fiscal_rw_fis_servico_regra'
  ) THEN
    CREATE POLICY fiscal_rw_fis_servico_regra ON public.fis_servico_regra FOR ALL TO authenticated
      USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
             OR public.has_role(auth.uid(),'gerente_financeiro'))
      WITH CHECK (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
             OR public.has_role(auth.uid(),'gerente_financeiro'));
  END IF;
END
$p$;
