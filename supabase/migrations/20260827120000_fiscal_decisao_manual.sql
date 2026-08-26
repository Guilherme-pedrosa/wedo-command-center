-- ============================================================================
-- Decisão manual item a item.
--
-- A regra automática continua decidindo tudo sozinha. Esta tabela existe para
-- quando quem conhece a operação discorda dela — e discorda com razão, como
-- aconteceu várias vezes: "alimentação" que era mão de obra de técnico,
-- "comissão" que era bônus por entrega, "treinamento sobre vendas" que era
-- nota emitida errada pelo prestador.
--
-- A decisão manual se sobrepõe à regra, mas não a apaga: o motivo gravado na
-- apuração mostra as duas — o que a regra dizia e o que a pessoa decidiu.
-- Crédito tomado por escolha humana precisa de responsável identificado.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.fis_item_decisao_manual (
  nf_entrada_item_id uuid PRIMARY KEY
    REFERENCES public.fis_nf_entrada_item(id) ON DELETE CASCADE,
  incluir      boolean NOT NULL,
  motivo       text,
  decidido_por text,
  decidido_em  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fis_item_decisao_manual IS
  'Decisao manual item a item: prevalece sobre a regra automatica. Grava quem decidiu e quando.';

ALTER TABLE public.fis_item_decisao_manual ENABLE ROW LEVEL SECURITY;

DO $p$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='fis_item_decisao_manual'
      AND policyname='fiscal_rw_fis_item_decisao_manual'
  ) THEN
    CREATE POLICY fiscal_rw_fis_item_decisao_manual ON public.fis_item_decisao_manual
      FOR ALL TO authenticated
      USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
             OR public.has_role(auth.uid(),'gerente_financeiro'))
      WITH CHECK (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
             OR public.has_role(auth.uid(),'gerente_financeiro'));
  END IF;
END
$p$;
