-- ============================================================================
-- Duas correções que só aparecem quando alguém reimporta um XML.
--
-- 1. A decisão manual estava chaveada pelo id do item. Reimportar apaga e
--    recria os itens, e o CASCADE levava junto a escolha da pessoa: você
--    marcaria uma nota à mão e perderia na importação seguinte, sem aviso.
--    A chave da NF mais o número do item sobrevivem a qualquer reimportação.
--
-- 2. Nota de saída não guardava o caminho do XML arquivado. A de entrada
--    sustenta o crédito; a de saída prova a receita e o imposto destacado.
--    Número sem arquivo não se defende em fiscalização.
-- ============================================================================

DROP TABLE IF EXISTS public.fis_item_decisao_manual;

CREATE TABLE public.fis_item_decisao_manual (
  chave_nf     text NOT NULL,
  ordem_item   int  NOT NULL,
  incluir      boolean NOT NULL,
  motivo       text,
  decidido_por text,
  decidido_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chave_nf, ordem_item)
);

COMMENT ON TABLE public.fis_item_decisao_manual IS
  'Decisao manual item a item, chaveada por (chave da NF, ordem do item) para sobreviver a reimportacao do XML. Prevalece sobre a regra automatica e grava quem decidiu.';

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

ALTER TABLE public.fis_nf_saida ADD COLUMN IF NOT EXISTS storage_path text;
COMMENT ON COLUMN public.fis_nf_saida.storage_path IS
  'Caminho do XML arquivado no bucket nf-xmls.';
