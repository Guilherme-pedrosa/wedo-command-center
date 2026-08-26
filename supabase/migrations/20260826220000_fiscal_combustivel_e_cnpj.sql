-- ============================================================================
-- Combustível da equipe: crédito que estava sendo bloqueado por duas regras
-- minhas, ambas erradas.
--
-- 1. CFOP 5929 estava classificado como "duplicidade contábil do ECF, não é
--    aquisição". Isso descreve a operação do lado do VENDEDOR: o posto emite a
--    NF-e para documentar uma venda que também passou pelo cupom fiscal. Do
--    lado de quem abastece, é aquisição real de combustível consumido na
--    operação. ICMS de combustível é retido por ST na cadeia, então aqui só
--    PIS/COFINS.
--
-- 2. CST 04 (monofásico) era veto absoluto. A vedação do monofásico está no
--    art. 3º, I, "b" da Lei 10.833/2003 e alcança bem adquirido para REVENDA.
--    O art. 3º, II, que trata de insumo, lista expressamente "combustíveis e
--    lubrificantes". Quem abastece a frota que atende cliente não está
--    revendendo gasolina. (Tratado no motor, em apuracaoFiscal.ts.)
-- ============================================================================

UPDATE public.fis_cfop_regra
SET gera_credito_piscofins = true,
    gera_credito_icms      = false,
    observacao = 'NF-e emitida para documentar venda tambem registrada em ECF (cupom). '
                 'Para o ADQUIRENTE e aquisicao real -- tipico de abastecimento em posto. '
                 'ICMS de combustivel e retido por ST na cadeia, entao so PIS/COFINS.',
    atualizado_em = now()
WHERE cfop IN ('5929','6929');

-- ---------------------------------------------------------------------------
-- CNPJ da empresa. Confirmado em 104 documentos emitidos pela propria WeDo:
-- as 33 NF-e de saida de julho/2026 e as 71 NFS-e do mesmo mes, duas fontes
-- independentes, todas com 43572954000181. É esse campo que separa entrada de
-- saída quando o XML é importado direto, sem consultar o GestãoClick.
-- ---------------------------------------------------------------------------
UPDATE public.fin_configuracoes
SET valor = '43572954000181', updated_at = now()
WHERE chave = 'CNPJ_EMPRESA'
  AND coalesce(valor,'') <> '43572954000181';
