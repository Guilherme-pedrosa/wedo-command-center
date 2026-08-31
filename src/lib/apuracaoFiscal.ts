/**
 * Motor de apuração fiscal — PIS/COFINS não-cumulativo (Lucro Real) e ICMS.
 *
 * Funções PURAS: nenhuma I/O, nenhum acesso a banco. Toda a decisão fiscal
 * mora aqui para poder ser testada isoladamente e auditada linha a linha.
 * As camadas de ingestão (edge functions) só alimentam estas funções.
 *
 * Toda decisão de crédito devolve o MOTIVO junto, porque em fiscalização o
 * número sem o porquê não defende ninguém.
 */

export const ALIQUOTA_PIS = 1.65;
export const ALIQUOTA_COFINS = 7.6;
export const ALIQUOTA_PIS_COFINS = ALIQUOTA_PIS + ALIQUOTA_COFINS; // 9,25%

/** Retenção na fonte (CSRF) sobre serviços prestados a PJ. */
export const ALIQUOTA_PIS_RETIDO = 0.65;
export const ALIQUOTA_COFINS_RETIDO = 3.0;

/**
 * CST de PIS/COFINS que o fornecedor grava no XML.
 *
 * ATENÇÃO — ponto que confunde: a nota que ENTRA aqui é a SAÍDA dele, então
 * o XML traz CST de saída (01, 02, 04...), não CST de entrada (50, 51, 60...).
 */
export const CST_COM_CREDITO = new Set(["01", "02"]);

/**
 * Vedação REAL, que nenhuma outra evidência derruba.
 *
 * 04 = tributação monofásica (contribuição concentrada na indústria)
 * 05 = substituição tributária
 *
 * Nestes dois a contribuição já foi paga em etapa anterior de forma
 * concentrada — creditar de novo é o item clássico de autuação
 * (Lei 10.833/2003, art. 3º, §2º, II). Vale inclusive contra o resgate
 * do Simples.
 */
export const CST_VEDACAO_ABSOLUTA = new Set(["04", "05"]);

/**
 * CST que o fornecedor usa quando NÃO houve destaque — mas que, sozinho,
 * não decide nada sobre o nosso direito ao crédito.
 *
 * O direito nasce da NOSSA operação: aquisição de insumo ou mercadoria para
 * revenda, com saída tributada. O CST do fornecedor é a papelada dele, e
 * "49 — outras operações" costuma ser default de ERP, não afirmação jurídica.
 *
 * Negar crédito de botina, gás refrigerante ou chapa galvanizada comprados
 * por pedido de compra, só porque o emitente escreveu 99, é jogar fora
 * crédito legítimo. Estes casos passam com marca de conferência, não com veto.
 */
export const CST_SEM_DESTAQUE = new Set(["03", "06", "07", "08", "09", "49", "99"]);

/** ICMS já retido anteriormente por ST: não há o que creditar. */
export const CST_ICMS_SEM_CREDITO = new Set(["60", "61"]);

export type RegimeEmitente =
  | "simples_nacional"
  | "mei"
  | "regime_normal"
  | "desconhecido";

export interface RegraCfop {
  cfop: string;
  sentido: "entrada" | "saida";
  compoeReceita: boolean;
  geraCreditoPisCofins: boolean;
  geraCreditoIcms: boolean;
}

export interface ItemEntrada {
  ordem: number;
  cfop: string | null;
  cstPis: string | null;
  cstCofins: string | null;
  cstIcms: string | null;
  valorProduto: number;
  valorDesconto?: number;
  valorFrete?: number;
  valorIcms?: number;
  /** pRedBC — redução de base do ICMS, só para o texto do motivo. */
  percReducaoBc?: number;
  ncm?: string | null;
  nomeProduto?: string | null;
  /** Aquisição de serviço (CFOP x933): o crédito depende da natureza dele. */
  ehServico?: boolean;
  /**
   * Combustível ou lubrificante consumido na prestação (NCM 2710, ou descrição
   * de gasolina/diesel/etanol/arla). Afasta a vedação do monofásico, que só
   * alcança aquisição para revenda.
   */
  ehCombustivelInsumo?: boolean;
  /**
   * Bem monofásico/ST adquirido para uso na atividade, não para revenda —
   * evidenciado por pedido de compra vinculado e CFOP de aquisição.
   */
  ehMonofasicoInsumo?: boolean;
  /**
   * Classificação do serviço em fis_servico_regra. true = insumo,
   * false = não insumo, null = nenhuma regra reconheceu a descrição.
   */
  servicoEhInsumo?: boolean | null;
  /** Categoria e fundamento da regra que classificou, para o rastro. */
  servicoCategoria?: string | null;
  servicoFundamento?: string | null;
}

export interface NotaEntrada {
  chave: string;
  crtEmitente: number | null;
  regimeEmitente: RegimeEmitente;
  nomeEmitente?: string | null;
  itens: ItemEntrada[];
}

export interface DecisaoCredito {
  permitido: boolean;
  base: number;
  motivo: string;
  /** Identificador curto da regra aplicada, para agrupar no relatório. */
  regra: string;
  /** true quando o crédito só existe por causa da regra de resgate do Simples. */
  viaResgateSimples: boolean;
  /** Exige conferência humana antes de fechar a competência. */
  requerRevisao: boolean;
}

export interface OpcoesCredito {
  /**
   * Inclui frete rateado na base do crédito. Default false: a Regra 2.4 fala
   * em "valor dos produtos". Ligue só depois de alinhar com a contabilidade.
   */
  incluirFrete?: boolean;
}

/** Arredondamento monetário: 2 casas, meio para cima. */
export function round2(valor: number): number {
  if (!Number.isFinite(valor)) return 0;
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

function normalizarCst(cst: string | null | undefined): string | null {
  if (cst === null || cst === undefined) return null;
  const limpo = String(cst).trim();
  if (!limpo) return null;
  return limpo.padStart(2, "0");
}

function baseDoItem(item: ItemEntrada, opcoes: OpcoesCredito): number {
  const frete = opcoes.incluirFrete ? (item.valorFrete ?? 0) : 0;
  return round2((item.valorProduto ?? 0) - (item.valorDesconto ?? 0) + frete);
}

/**
 * Regra 2 completa: decide se um item de entrada gera crédito de PIS/COFINS.
 *
 * Ordem de avaliação:
 *  1. CFOP precisa estar na lista de entradas que admitem crédito (Regra 2.2).
 *  2. CST 04/05 (monofásico/ST) bloqueia sempre, inclusive Simples (Regra 2.4).
 *  3. Fornecedor do Simples: crédito integral ignorando o CST (Regra 2.4).
 *  4. Demais: só CST 01 (Regra 2.3).
 */
export function decidirCreditoPisCofins(
  item: ItemEntrada,
  nota: Pick<NotaEntrada, "regimeEmitente" | "crtEmitente"> & {
    /** A nota está amarrada a um pedido de compra? Prova de uso operacional. */
    temPedidoCompra?: boolean;
    /**
     * Emitente é pessoa física (CPF). MEI NÃO entra aqui: MEI tem CNPJ, é
     * pessoa jurídica, e credita normalmente.
     */
    emitentePessoaFisica?: boolean;
  },
  regra: RegraCfop | null,
  opcoes: OpcoesCredito = {},
): DecisaoCredito {
  const base = baseDoItem(item, opcoes);
  const cst = normalizarCst(item.cstPis) ?? normalizarCst(item.cstCofins);

  const negar = (motivo: string, regraId: string, requerRevisao = false): DecisaoCredito => ({
    permitido: false, base: 0, motivo, regra: regraId, viaResgateSimples: false, requerRevisao,
  });
  const permitir = (
    motivo: string,
    regraId: string,
    { simples = false, revisar = false } = {},
  ): DecisaoCredito => ({
    permitido: true, base, motivo, regra: regraId,
    viaResgateSimples: simples, requerRevisao: revisar,
  });

  // ── 0. Emitente pessoa física ──────────────────────────────────────────
  // Lei 10.833/2003 art. 3º, §2º, I e §3º, I: crédito exige aquisição de
  // pessoa jurídica domiciliada no País. MEI tem CNPJ e é pessoa jurídica,
  // então NÃO cai aqui — credita como qualquer outro optante do Simples.
  if (nota.emitentePessoaFisica) {
    return negar(
      "Emitente é pessoa física (CPF). Mão de obra paga a pessoa física não gera " +
      "crédito (Lei 10.833/2003, art. 3º, §2º, I).",
      "PESSOA_FISICA",
    );
  }

  // ── 1. Veto absoluto: a contribuição já foi paga concentrada ────────────
  // Único ponto onde o CST do fornecedor decide sozinho, porque monofásico e
  // ST são regime de tributação, não preenchimento de nota.
  if (cst && CST_VEDACAO_ABSOLUTA.has(cst)) {
    // A vedação do monofásico está no art. 3º, I, "b" e alcança a aquisição
    // PARA REVENDA. O art. 3º, II, que trata de insumo, não a repete — ao
    // contrário, nomeia "inclusive combustíveis e lubrificantes".
    //
    // Então a linha não é o CST, é a destinação: monofásico para revender não
    // credita; monofásico consumido na atividade credita. Quem abastece a
    // frota que atende cliente não está revendendo gasolina, e quem aplica a
    // peça no equipamento do cliente não está revendendo autopeça.
    //
    // Combustível tem apoio literal no inciso II. Os demais monofásicos como
    // insumo são posição defensável mas discutida pela Receita — por isso
    // creditam com marca de conferência, não em silêncio.
    if (item.ehCombustivelInsumo) {
      return permitir(
        `Combustível/lubrificante consumido na prestação do serviço. A vedação do ` +
        `monofásico (art. 3º, I, "b") alcança aquisição para revenda; o art. 3º, II ` +
        `admite expressamente "combustíveis e lubrificantes" como insumo.`,
        "COMBUSTIVEL_INSUMO",
      );
    }
    if (item.ehMonofasicoInsumo) {
      return permitir(
        `CST ${cst} (${cst === "04" ? "monofásico" : "ST"}), mas o item foi adquirido ` +
        `para uso na atividade, não para revenda — há pedido de compra vinculado. ` +
        `A vedação do art. 3º, I, "b" alcança aquisição para revenda; como insumo ` +
        `aplica-se o art. 3º, II. Posição defensável, discutida pela Receita: ` +
        `confirmar com a contabilidade antes de fechar.`,
        "MONOFASICO_COMO_INSUMO",
        { revisar: true },
      );
    }
    return negar(
      `CST ${cst} — ${cst === "04" ? "tributação monofásica" : "substituição tributária"}: ` +
      `contribuição recolhida em etapa anterior e não há evidência de uso na ` +
      `atividade (sem pedido de compra vinculado). Lei 10.833/2003, art. 3º, I, "b".`,
      "CST_MONOFASICO_ST",
    );
  }

  // ── 2. A operação é uma aquisição? ─────────────────────────────────────
  if (!item.cfop) {
    return negar("Item sem CFOP no XML — impossível classificar", "CFOP_AUSENTE", true);
  }
  if (!regra) {
    return negar(
      `CFOP ${item.cfop} não cadastrado em fis_cfop_regra — classificar antes de fechar`,
      "CFOP_NAO_CADASTRADO", true,
    );
  }
  if (!regra.geraCreditoPisCofins) {
    // Remessa, conserto, garantia, comodato: não houve aquisição.
    return negar(
      `CFOP ${item.cfop} não é aquisição (remessa/conserto/garantia) — nada a creditar`,
      "CFOP_NAO_AQUISICAO",
    );
  }

  // ── 2b. Serviço tomado: o CFOP prova que houve serviço, não que é insumo ─
  // O direito depende de essencialidade e relevância para a atividade
  // (Lei 10.833/2003, art. 3º, II; STJ REsp 1.221.170/PR). Alimentação,
  // comissão de venda, treinamento comercial e viagem não passam nesse teste,
  // venham de quem vierem — inclusive de fornecedor do Simples ou MEI.
  if (item.ehServico) {
    if (item.servicoEhInsumo === true) {
      return permitir(
        `Serviço classificado como ${item.servicoCategoria ?? "insumo"} — ` +
        `${item.servicoFundamento ?? "insumo da atividade"}`,
        "SERVICO_INSUMO",
        { simples: nota.regimeEmitente === "simples_nacional" || nota.regimeEmitente === "mei" },
      );
    }
    if (item.servicoEhInsumo === false) {
      return negar(
        `Serviço classificado como ${item.servicoCategoria ?? "não insumo"} — ` +
        `${item.servicoFundamento ?? "não integra o processo produtivo"}`,
        "SERVICO_NAO_INSUMO",
      );
    }
    return negar(
      `Serviço sem descrição que permita classificar ("${item.nomeProduto ?? ""}"). ` +
      `Cobrar descrição do prestador ou cadastrar a regra em fis_servico_regra.`,
      "SERVICO_INDECIDIVEL",
      true,
    );
  }

  // ── 3. Alíquota é sempre a nossa, não a do fornecedor ──────────────────
  // Simples, Lucro Presumido (cumulativo, 0,65/3%) ou Lucro Real: o crédito
  // do adquirente no não-cumulativo é 1,65% + 7,6% sobre o valor da aquisição.
  // O regime do emitente não reduz a nossa alíquota.
  const simples = nota.regimeEmitente === "simples_nacional" || nota.regimeEmitente === "mei";
  const rotuloRegime = simples
    ? `Simples Nacional (CRT ${nota.crtEmitente ?? "?"})`
    : nota.regimeEmitente === "regime_normal"
      ? "regime normal (Lucro Real ou Presumido)"
      : "regime não identificado";

  // ── 4. CST do fornecedor: evidência, não veredicto ─────────────────────
  if (cst && CST_COM_CREDITO.has(cst)) {
    return permitir(
      `CST ${cst} com destaque, fornecedor ${rotuloRegime} — crédito de ${ALIQUOTA_PIS_COFINS}%`,
      simples ? "RESGATE_SIMPLES" : "CST_TRIBUTADO",
      { simples },
    );
  }

  if (simples) {
    // ADI SRF 15/2007 e IN RFB 2.121/2022: aquisição de optante do Simples
    // gera crédito integral, qualquer que seja o CST que ele declarou.
    return permitir(
      `Fornecedor ${rotuloRegime} — crédito integral de ${ALIQUOTA_PIS_COFINS}% ` +
      `independente do CST ${cst ?? "não informado"} (IN RFB 2.121/2022)`,
      "RESGATE_SIMPLES",
      { simples: true },
    );
  }

  if (!cst || CST_SEM_DESTAQUE.has(cst)) {
    // Sem destaque na origem. O direito vem da nossa operação: se a nota está
    // amarrada a pedido de compra, o bem entrou para uso na atividade.
    if (nota.temPedidoCompra) {
      return permitir(
        `CST ${cst ?? "ausente"} sem destaque na origem, mas a nota está amarrada a ` +
        `pedido de compra — aquisição para uso na operação, crédito de ${ALIQUOTA_PIS_COFINS}%. ` +
        `Conferir se o produto não é monofásico por NCM.`,
        "SEM_DESTAQUE_COM_PEDIDO",
        { revisar: true },
      );
    }
    return negar(
      `CST ${cst ?? "ausente"} sem destaque e sem pedido de compra vinculado — ` +
      `não há evidência de aquisição para a operação`,
      "SEM_DESTAQUE_SEM_PEDIDO",
      true,
    );
  }

  return permitir(
    `CST ${cst} fora da tabela conhecida, fornecedor ${rotuloRegime} — ` +
    `creditado com marca de conferência`,
    "CST_DESCONHECIDO",
    { revisar: true },
  );
}

/**
 * Crédito de ICMS na entrada.
 * Mantém a decisão já adotada no projeto: fornecedor do Simples não transfere
 * crédito de ICMS. O valor creditado é o efetivamente destacado no item.
 */
export function decidirCreditoIcms(
  item: ItemEntrada,
  nota: Pick<NotaEntrada, "regimeEmitente">,
  regra: RegraCfop | null,
): DecisaoCredito {
  const valorIcms = round2(item.valorIcms ?? 0);
  const cstIcms = normalizarCst(item.cstIcms);

  const negar = (motivo: string, regraId: string, requerRevisao = false): DecisaoCredito => ({
    permitido: false, base: 0, motivo, regra: regraId,
    viaResgateSimples: false, requerRevisao,
  });

  if (!regra) {
    return negar(
      `CFOP ${item.cfop ?? "ausente"} não cadastrado — classificar antes de fechar`,
      "CFOP_NAO_CADASTRADO", true,
    );
  }

  // ICMS e PIS/COFINS são independentes: mercadoria com ST gera crédito de
  // PIS/COFINS mas não de ICMS, porque o ICMS já foi retido na cadeia.
  if (!regra.geraCreditoIcms) {
    return negar(
      `CFOP ${item.cfop} não admite crédito de ICMS` +
      (regra.geraCreditoPisCofins ? " (mas admite de PIS/COFINS)" : ""),
      "CFOP_SEM_CREDITO_ICMS",
    );
  }

  if (nota.regimeEmitente === "simples_nacional" || nota.regimeEmitente === "mei") {
    return negar(
      "Fornecedor do Simples Nacional não transfere crédito de ICMS",
      "SIMPLES_SEM_ICMS",
    );
  }

  // CST 60/61: ICMS já retido anteriormente por substituição tributária.
  if (cstIcms && CST_ICMS_SEM_CREDITO.has(cstIcms)) {
    return negar(
      `CST ICMS ${cstIcms} — imposto já retido por ST em etapa anterior`,
      "ICMS_ST_ANTERIOR",
    );
  }

  if (valorIcms <= 0) {
    return negar("Sem ICMS destacado no item", "ICMS_SEM_DESTAQUE");
  }

  // O valor destacado já vem líquido da redução de base (pRedBC aplicado pelo
  // emitente ao calcular vICMS), então creditamos o destaque, não a alíquota
  // cheia sobre o valor do produto.
  const reducao = item.percReducaoBc ?? 0;
  return {
    permitido: true,
    base: valorIcms,
    motivo:
      `ICMS destacado de R$ ${valorIcms.toFixed(2)}` +
      (reducao > 0 ? ` (base reduzida em ${reducao}%)` : "") +
      " — crédito admitido",
    regra: "ICMS_DESTACADO",
    viaResgateSimples: false,
    requerRevisao: false,
  };
}

// ---------------------------------------------------------------------------
// Regra 1 — base de débito (faturamento)
// ---------------------------------------------------------------------------

export interface NotaSaida {
  gcId: string;
  modelo: "55" | "65" | "NFSE";
  numero?: string | null;
  autorizada: boolean;
  cancelada: boolean;
  denegada: boolean;
  codigoCfop: string | null;
  naturezaOperacao?: string | null;
  valorProdutos: number;
  valorServico: number;
  valorDesconto?: number;
  /** ICMS destacado na nota — excluído da base de PIS/COFINS (RE 574.706/STF). */
  valorIcms?: number;
  /** ICMS-ST, quando cobrado do cliente, também não é receita própria. */
  valorIcmsSt?: number;
  /** vNF — valor da nota. Preferido como base: já traz frete e outros. */
  valorTotalNf?: number;
  /** IPI não integra a receita bruta e por isso sai da base. */
  valorIpi?: number;
}

export interface DecisaoReceita {
  compoe: boolean;
  valor: number;
  motivo: string;
  requerRevisao: boolean;
  /** ICMS + ICMS-ST retirados da base de PIS/COFINS (RE 574.706). */
  icmsExcluido?: number;
}


/** Palavras que marcam natureza de não-receita quando o CFOP não basta. */
const NATUREZAS_NAO_RECEITA = [
  /devolu[çc][ãa]o\s+de\s+compra/i,
  /bonifica[çc][ãa]o/i,
  /brinde/i,
  /retorno\s+de\s+remessa/i,
  /remessa\s+em\s+garantia/i,
];

/**
 * Regra 1: a nota entra na base de débito?
 * Filtra status (1.2) e expurga naturezas de não-receita (1.3).
 */
export function decidirReceitaSaida(
  nota: NotaSaida,
  regra: RegraCfop | null,
): DecisaoReceita {
  // Base = valor da nota menos IPI, menos o ICMS destacado (e ICMS-ST).
  // O vNF já embute frete, seguro e outras despesas cobradas do cliente, que
  // integram a receita bruta. O IPI não é receita; o ICMS destacado também não
  // compõe a base de PIS/COFINS (STF, RE 574.706, repercussão geral).
  const bruto =
    (nota.valorTotalNf ?? 0) > 0
      ? (nota.valorTotalNf as number) - (nota.valorIpi ?? 0)
      : (nota.valorProdutos ?? 0) + (nota.valorServico ?? 0) - (nota.valorDesconto ?? 0);
  const icmsExcluido = (nota.valorIcms ?? 0) + (nota.valorIcmsSt ?? 0);
  const valor = round2(Math.max(0, bruto - icmsExcluido));

  if (nota.cancelada) {
    return { compoe: false, valor: 0, motivo: "Nota cancelada", requerRevisao: false };
  }
  if (nota.denegada) {
    return { compoe: false, valor: 0, motivo: "Nota denegada", requerRevisao: false };
  }
  if (!nota.autorizada) {
    return {
      compoe: false,
      valor: 0,
      motivo: "Nota não autorizada — fora da base até regularização",
      requerRevisao: true,
    };
  }

  // NFS-e não tem CFOP; a natureza da operação é o que resta.
  if (nota.modelo === "NFSE") {
    const natureza = nota.naturezaOperacao ?? "";
    const naoReceita = NATUREZAS_NAO_RECEITA.find((re) => re.test(natureza));
    if (naoReceita) {
      return {
        compoe: false,
        valor: 0,
        motivo: `Natureza "${natureza}" caracteriza não-receita (Regra 1.3)`,
        requerRevisao: false,
      };
    }
    return {
      compoe: true,
      valor,
      motivo: "Serviço tributado",
      requerRevisao: false,
      icmsExcluido: icmsExcluido,
    };
  }

  if (!nota.codigoCfop) {
    return {
      compoe: false,
      valor: 0,
      motivo: "NF-e sem CFOP — classificar antes de fechar",
      requerRevisao: true,
    };
  }

  if (!regra) {
    return {
      compoe: false,
      valor: 0,
      motivo: `CFOP ${nota.codigoCfop} não cadastrado em fis_cfop_regra`,
      requerRevisao: true,
    };
  }

  if (!regra.compoeReceita) {
    return {
      compoe: false,
      valor: 0,
      motivo: `CFOP ${nota.codigoCfop} expurgado da base (Regra 1.3)`,
      requerRevisao: false,
    };
  }

  return {
    compoe: true,
    valor,
    motivo: `CFOP ${nota.codigoCfop} — receita tributável`,
    requerRevisao: false,
  };
}

// ---------------------------------------------------------------------------
// Consolidação
// ---------------------------------------------------------------------------

export interface ResultadoTributo {
  tributo: "PIS" | "COFINS" | "ICMS";
  aliquota: number;
  receitaBruta: number;
  baseDebito: number;
  valorDebito: number;
  baseCredito: number;
  baseCreditoSimples: number;
  valorCredito: number;
  valorRetencoes: number;
  saldoCredorAnterior: number;
  saldoARecolher: number;
  saldoCredorProximo: number;
}

export interface EntradasApuracao {
  receitaBruta: number;
  baseDebito: number;
  baseCredito: number;
  baseCreditoSimples: number;
  retencaoPis: number;
  retencaoCofins: number;
  saldoCredorAnteriorPis: number;
  saldoCredorAnteriorCofins: number;
}

function consolidar(
  tributo: "PIS" | "COFINS",
  aliquota: number,
  e: EntradasApuracao,
  retencao: number,
  saldoAnterior: number,
): ResultadoTributo {
  const valorDebito = round2((e.baseDebito * aliquota) / 100);
  const valorCredito = round2((e.baseCredito * aliquota) / 100);
  const liquido = round2(valorDebito - valorCredito - retencao - saldoAnterior);

  return {
    tributo,
    aliquota,
    receitaBruta: round2(e.receitaBruta),
    baseDebito: round2(e.baseDebito),
    valorDebito,
    baseCredito: round2(e.baseCredito),
    baseCreditoSimples: round2(e.baseCreditoSimples),
    valorCredito,
    valorRetencoes: round2(retencao),
    saldoCredorAnterior: round2(saldoAnterior),
    saldoARecolher: liquido > 0 ? liquido : 0,
    saldoCredorProximo: liquido < 0 ? round2(-liquido) : 0,
  };
}

/** Apura PIS e COFINS separadamente (as guias e os saldos credores são distintos). */
export function apurarPisCofins(e: EntradasApuracao): {
  pis: ResultadoTributo;
  cofins: ResultadoTributo;
  saldoTotalARecolher: number;
} {
  const pis = consolidar("PIS", ALIQUOTA_PIS, e, e.retencaoPis, e.saldoCredorAnteriorPis);
  const cofins = consolidar(
    "COFINS",
    ALIQUOTA_COFINS,
    e,
    e.retencaoCofins,
    e.saldoCredorAnteriorCofins,
  );
  return {
    pis,
    cofins,
    saldoTotalARecolher: round2(pis.saldoARecolher + cofins.saldoARecolher),
  };
}

// ---------------------------------------------------------------------------
// Regra 3 — retenções na fonte, rateadas por liquidação
// ---------------------------------------------------------------------------

export interface NfseComRetencao {
  nfSaidaId: string;
  numero: string;
  valorTotalNf: number;
  valorPisRetido: number;
  valorCofinsRetido: number;
}

export interface Liquidacao {
  recebimentoId: string;
  nfNumero: string | null;
  valor: number;
  dataLiquidacao: string;
  nomeCliente?: string | null;
}

export interface RetencaoRateada {
  nfSaidaId: string;
  recebimentoId: string;
  nfNumero: string;
  nomeCliente: string | null;
  dataLiquidacao: string;
  valorBase: number;
  valorPisRetido: number;
  valorCofinsRetido: number;
  proporcao: number;
}

export interface RateioResultado {
  retencoes: RetencaoRateada[];
  totalPis: number;
  totalCofins: number;
  avisos: { tipo: string; referencia: string; descricao: string }[];
}

/**
 * A NFS-e declara a retenção na EMISSÃO; a guia deduz na LIQUIDAÇÃO.
 * Quando a nota é paga em parcelas, a CSRF é retida proporcionalmente a cada
 * baixa — creditar o valor cheio na primeira parcela adianta dedução e é
 * exatamente o tipo de erro que aparece só na malha.
 *
 * Recebe as liquidações de UMA competência e rateia a retenção de cada nota
 * na proporção do que foi efetivamente recebido.
 */
export function ratearRetencoes(
  notas: NfseComRetencao[],
  liquidacoes: Liquidacao[],
): RateioResultado {
  const porNumero = new Map<string, NfseComRetencao>();
  for (const n of notas) {
    if (n.numero) porNumero.set(String(n.numero).trim(), n);
  }

  const retencoes: RetencaoRateada[] = [];
  const avisos: RateioResultado["avisos"] = [];
  /** Acumula proporção já rateada por nota, para não passar de 100%. */
  const consumido = new Map<string, number>();

  for (const liq of liquidacoes) {
    const numero = String(liq.nfNumero ?? "").trim();
    if (!numero) continue;

    const nota = porNumero.get(numero);
    if (!nota) continue; // recebimento sem NFS-e com retenção: nada a deduzir

    if (nota.valorPisRetido === 0 && nota.valorCofinsRetido === 0) continue;

    if (nota.valorTotalNf <= 0) {
      avisos.push({
        tipo: "NFSE_SEM_VALOR",
        referencia: numero,
        descricao:
          `NFS-e ${numero} tem retenção declarada mas valor total zero — ` +
          `impossível ratear. Lançar a retenção manualmente.`,
      });
      continue;
    }

    const jaConsumido = consumido.get(numero) ?? 0;
    const bruta = liq.valor / nota.valorTotalNf;
    const proporcao = Math.min(bruta, Math.max(0, 1 - jaConsumido));

    if (proporcao <= 0) {
      avisos.push({
        tipo: "RETENCAO_JA_INTEGRAL",
        referencia: numero,
        descricao:
          `NFS-e ${numero}: liquidações somam mais que o valor da nota. ` +
          `Retenção já rateada integralmente; excedente ignorado.`,
      });
      continue;
    }

    if (bruta > proporcao) {
      avisos.push({
        tipo: "LIQUIDACAO_EXCEDE_NOTA",
        referencia: numero,
        descricao:
          `NFS-e ${numero}: baixas excedem o valor da nota. Rateio limitado a 100%.`,
      });
    }

    consumido.set(numero, jaConsumido + proporcao);

    retencoes.push({
      nfSaidaId: nota.nfSaidaId,
      recebimentoId: liq.recebimentoId,
      nfNumero: numero,
      nomeCliente: liq.nomeCliente ?? null,
      dataLiquidacao: liq.dataLiquidacao,
      valorBase: round2(liq.valor),
      valorPisRetido: round2(nota.valorPisRetido * proporcao),
      valorCofinsRetido: round2(nota.valorCofinsRetido * proporcao),
      proporcao,
    });
  }

  return {
    retencoes,
    totalPis: round2(retencoes.reduce((s, r) => s + r.valorPisRetido, 0)),
    totalCofins: round2(retencoes.reduce((s, r) => s + r.valorCofinsRetido, 0)),
    avisos,
  };
}

export interface EntradasIcms {
  debitoDestacado: number;
  creditoDestacado: number;
  saldoCredorAnterior: number;
}

/**
 * ICMS é apurado por confronto de valores destacados, não por alíquota única:
 * cada item pode ter alíquota diferente conforme UF de destino e NCM.
 */
export function apurarIcms(e: EntradasIcms): ResultadoTributo {
  const liquido = round2(e.debitoDestacado - e.creditoDestacado - e.saldoCredorAnterior);
  return {
    tributo: "ICMS",
    aliquota: 0,
    receitaBruta: 0,
    baseDebito: 0,
    valorDebito: round2(e.debitoDestacado),
    baseCredito: 0,
    baseCreditoSimples: 0,
    valorCredito: round2(e.creditoDestacado),
    valorRetencoes: 0,
    saldoCredorAnterior: round2(e.saldoCredorAnterior),
    saldoARecolher: liquido > 0 ? liquido : 0,
    saldoCredorProximo: liquido < 0 ? round2(-liquido) : 0,
  };
}

// ---------------------------------------------------------------------------
// Amarração entre pedido de compra e nota fiscal
// ---------------------------------------------------------------------------

/**
 * Número de NF sem os zeros à esquerda. O ERP grava "000123", o XML grava
 * "123", e os dois são a mesma nota.
 */
export function numeroNf(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/^0+/, "");
}

/**
 * Raiz do CNPJ — os 8 primeiros dígitos, que identificam a empresa.
 *
 * Matriz e filial só diferem no sufixo. O pedido costuma ficar no CNPJ da
 * matriz enquanto a nota sai da filial, e comparar os 14 dígitos separa duas
 * coisas que são o mesmo fornecedor.
 */
export function raizCnpj(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "").slice(0, 8);
}

/**
 * Nome de fornecedor reduzido a letras e números comparáveis.
 *
 * O Gestão Click cola o CNPJ na frente da razão social — "62.197.586 AYRTON
 * EULER..." — então o prefixo numérico sai antes de qualquer coisa. Acentos e
 * pontuação também, porque o mesmo fornecedor aparece com e sem eles.
 */
export function normalizarNomeFornecedor(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/^[\d.\-/\s]+/, "")
    .normalize("NFD")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export interface PedidoCompra {
  numeroNfe: string | null;
  cnpjFornecedor: string | null;
  nomeFornecedor: string | null;
}

export interface NotaParaCasar {
  numero: string | null;
  cnpjEmitente: string | null;
  nomeEmitente: string | null;
}

/**
 * Índice de pedidos de compra para perguntar "esta nota tem pedido?".
 *
 * Casar só pelo número da nota não funciona: numeração de NF é por emitente e
 * se repete o tempo todo. Na base da WeDo isso dava 291 notas (R$ 387 mil)
 * herdando o pedido de outro fornecedor — e, do outro lado, calava o alerta de
 * compra sem XML em 99,7% dos casos, porque qualquer nota com o mesmo número
 * servia de álibi.
 *
 * Então o par (número, identidade do fornecedor) é a chave, e a identidade
 * aceita três provas, em ordem de força:
 *   1. raiz do CNPJ do pedido bate com a do emitente;
 *   2. o CNPJ que o ERP colou no começo do nome bate com a do emitente
 *      (10,6% dos pedidos vêm sem o campo de CNPJ preenchido);
 *   3. o nome normalizado é idêntico.
 *
 * Sobram 38 notas sem casar, quase todas por divergência de cadastro
 * ("PAULINELIS" na nota, "PAULINERIS" no pedido).
 */
export function indexarPedidos(pedidos: PedidoCompra[]): {
  temPedido: (nota: NotaParaCasar) => boolean;
  /** Pedidos cuja nota não foi encontrada — a lista de XML que falta baixar. */
  semNota: (notas: NotaParaCasar[]) => PedidoCompra[];
} {
  const porNumero = new Map<string, PedidoCompra[]>();
  for (const p of pedidos) {
    const num = numeroNf(p.numeroNfe);
    if (!num) continue;
    const lista = porNumero.get(num);
    if (lista) lista.push(p);
    else porNumero.set(num, [p]);
  }

  const casa = (p: PedidoCompra, nota: NotaParaCasar): boolean => {
    const raizNota = raizCnpj(nota.cnpjEmitente);
    if (raizNota) {
      if (raizCnpj(p.cnpjFornecedor) === raizNota) return true;
      // O ERP prefixa o CNPJ no nome quando o campo próprio vem vazio.
      const prefixo = (p.nomeFornecedor ?? "").match(/^[\d.\-/\s]+/)?.[0] ?? "";
      if (raizCnpj(prefixo) === raizNota) return true;
    }
    const nome = normalizarNomeFornecedor(p.nomeFornecedor);
    return nome !== "" && nome === normalizarNomeFornecedor(nota.nomeEmitente);
  };

  const temPedido = (nota: NotaParaCasar): boolean =>
    (porNumero.get(numeroNf(nota.numero)) ?? []).some((p) => casa(p, nota));

  const semNota = (notas: NotaParaCasar[]): PedidoCompra[] =>
    pedidos.filter((p) => {
      if (!numeroNf(p.numeroNfe)) return false;
      return !notas.some((n) => numeroNf(n.numero) === numeroNf(p.numeroNfe) && casa(p, n));
    });

  return { temPedido, semNota };
}
