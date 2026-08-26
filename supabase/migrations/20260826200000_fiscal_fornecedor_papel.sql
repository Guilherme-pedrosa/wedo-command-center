-- ============================================================================
-- Papel do prestador de serviço na operação.
--
-- Classificar serviço pela descrição da linha erra quando o prestador é um MEI
-- que executa em cliente: ele discrimina o próprio preço em "manutenção",
-- "alimentação durante a prestação" e "premiação" (cláusula contratual de
-- recebível variável do técnico). Nada disso é despesa de pessoal do tomador —
-- é o preço de um serviço que integra a prestação vendida ao cliente.
--
-- Então quem decide é o PAPEL do fornecedor, não a linha. Um prestador de campo
-- tem a nota inteira como insumo; um representante comercial não tem, mesmo que
-- alguma linha diga "manutenção".
--
-- origem='inferido' foi deduzido dos dados. origem='declarado' foi afirmado por
-- pessoa responsável, com nome gravado — é declaração do contribuinte, e o
-- rastro precisa mostrar isso para quem auditar.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.fis_fornecedor_papel (
  cnpj           text PRIMARY KEY,
  nome           text,
  papel          text NOT NULL CHECK (papel IN
                   ('prestador_campo','software_operacional','comercial','nao_operacional','indefinido')),
  credita        boolean NOT NULL,
  justificativa  text NOT NULL,
  origem         text NOT NULL DEFAULT 'declarado' CHECK (origem IN ('declarado','inferido')),
  declarado_por  text,
  declarado_em   timestamptz DEFAULT now()
);

COMMENT ON TABLE public.fis_fornecedor_papel IS
  'Papel do prestador de servico. Prestador de campo tem a NFS-e inteira como insumo. origem=declarado prevalece sobre inferido.';

-- Semeia prestadores de campo a partir do proprio historico: quem faturou
-- manutencao, instalacao, conserto ou atendimento em cliente.
INSERT INTO public.fis_fornecedor_papel (cnpj, nome, papel, credita, justificativa, origem)
SELECT DISTINCT e.cnpj_emitente, e.nome_emitente, 'prestador_campo', true,
  'Faturou servico executado em equipamento de cliente. Insumo direto da prestacao vendida.',
  'inferido'
FROM public.fis_nf_entrada e
JOIN public.fis_nf_entrada_item i ON i.nf_entrada_id = e.id
WHERE i.cfop = '5933'
  AND i.nome_produto ~* 'manuten|instala|conserto|repara|t[ée]cnic|munck|descarga|frete|lavagem|emergencial'
ON CONFLICT (cnpj) DO NOTHING;

ALTER TABLE public.fis_fornecedor_papel ENABLE ROW LEVEL SECURITY;

DO $p$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='fis_fornecedor_papel'
      AND policyname='fiscal_rw_fis_fornecedor_papel'
  ) THEN
    CREATE POLICY fiscal_rw_fis_fornecedor_papel ON public.fis_fornecedor_papel FOR ALL TO authenticated
      USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
             OR public.has_role(auth.uid(),'gerente_financeiro'))
      WITH CHECK (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
             OR public.has_role(auth.uid(),'gerente_financeiro'));
  END IF;
END
$p$;
