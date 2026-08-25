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
 * É esse código que a Regra 2.3 avalia.
 */
export const CST_COM_CREDITO = new Set(["01"]);

/** Regra 2.3 — bloqueio explícito. */
export const CST_SEM_CREDITO = new Set(["02", "04", "05", "06", "07", "08", "49", "99"]);

/**
 * Regra 2.4 — exceção à "regra de resgate" do Simples Nacional.
 * 04 = monofásico, 05 = substituição tributária. Nem o resgate libera.
 */
export const CST_BLOQUEIA_ATE_SIMPLES = new Set(["04", "05"]);

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
  ncm?: string | null;
  nomeProduto?: string | null;
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
  nota: Pick<NotaEntrada, "regimeEmitente" | "crtEmitente">,
  regra: RegraCfop | null,
  opcoes: OpcoesCredito = {},
): DecisaoCredito {
  const base = baseDoItem(item, opcoes);
  const cst = normalizarCst(item.cstPis) ?? normalizarCst(item.cstCofins);

  const negar = (
    motivo: string,
    regraId: string,
    requerRevisao = false,
  ): DecisaoCredito => ({
    permitido: false,
    base: 0,
    motivo,
    regra: regraId,
    viaResgateSimples: false,
    requerRevisao,
  });

  if (!item.cfop) {
    return negar("Item sem CFOP no XML — impossível classificar", "CFOP_AUSENTE", true);
  }

  if (!regra) {
    return negar(
      `CFOP ${item.cfop} não cadastrado em fis_cfop_regra — classificar antes de fechar`,
      "CFOP_NAO_CADASTRADO",
      true,
    );
  }

  if (!regra.geraCreditoPisCofins) {
    return negar(
      `CFOP ${item.cfop} não admite crédito de PIS/COFINS`,
      "CFOP_SEM_CREDITO",
    );
  }

  // CST 04/05 bloqueiam mesmo sob a regra de resgate do Simples.
  if (cst && CST_BLOQUEIA_ATE_SIMPLES.has(cst)) {
    return negar(
      `CST ${cst} (monofásico/ST) — vedação absoluta, não alcançada pelo resgate do Simples`,
      "CST_MONOFASICO_ST",
    );
  }

  // Regra 2.4 — resgate do Simples Nacional.
  if (nota.regimeEmitente === "simples_nacional") {
    return {
      permitido: true,
      base,
      motivo:
        `Fornecedor optante pelo Simples Nacional (CRT ${nota.crtEmitente}) — ` +
        `crédito integral de ${ALIQUOTA_PIS_COFINS}% independente do CST ${cst ?? "não informado"} ` +
        `(IN RFB 2.121/2022, que sucedeu a IN RFB 1.911/2019)`,
      regra: "RESGATE_SIMPLES",
      viaResgateSimples: true,
      requerRevisao: false,
    };
  }

  // MEI não é decidido automaticamente: não assumir.
  if (nota.regimeEmitente === "mei") {
    return negar(
      "Fornecedor MEI (CRT 4) — enquadramento não coberto pela regra de resgate; revisar manualmente",
      "MEI_REVISAR",
      true,
    );
  }

  if (nota.regimeEmitente === "desconhecido") {
    return negar(
      "CRT do emitente ausente ou inválido no XML — não é possível decidir sem supor",
      "CRT_AUSENTE",
      true,
    );
  }

  // Regra 2.3 — regime normal.
  if (!cst) {
    return negar(
      "Item sem CST de PIS/COFINS no XML — não é possível decidir sem supor",
      "CST_AUSENTE",
      true,
    );
  }

  if (CST_COM_CREDITO.has(cst)) {
    return {
      permitido: true,
      base,
      motivo: `CST ${cst} — operação tributada com alíquota básica, crédito admitido`,
      regra: "CST_01",
      viaResgateSimples: false,
      requerRevisao: false,
    };
  }

  if (CST_SEM_CREDITO.has(cst)) {
    return negar(`CST ${cst} — bloqueado pela Regra 2.3`, "CST_BLOQUEADO");
  }

  return negar(
    `CST ${cst} fora da tabela conhecida — classificar manualmente`,
    "CST_DESCONHECIDO",
    true,
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

  const negar = (motivo: string, regraId: string, requerRevisao = false): DecisaoCredito => ({
    permitido: false,
    base: 0,
    motivo,
    regra: regraId,
    viaResgateSimples: false,
    requerRevisao,
  });

  if (!regra) {
    return negar(
      `CFOP ${item.cfop ?? "ausente"} não cadastrado — classificar antes de fechar`,
      "CFOP_NAO_CADASTRADO",
      true,
    );
  }
  if (!regra.geraCreditoIcms) {
    return negar(`CFOP ${item.cfop} não admite crédito de ICMS`, "CFOP_SEM_CREDITO_ICMS");
  }
  if (nota.regimeEmitente === "simples_nacional" || nota.regimeEmitente === "mei") {
    return negar(
      "Fornecedor do Simples Nacional não transfere crédito de ICMS",
      "SIMPLES_SEM_ICMS",
    );
  }
  if (valorIcms <= 0) {
    return negar("Sem ICMS destacado no item", "ICMS_SEM_DESTAQUE");
  }

  return {
    permitido: true,
    base: valorIcms,
    motivo: `ICMS destacado de R$ ${valorIcms.toFixed(2)} — crédito admitido`,
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
  valorIcms?: number;
}

export interface DecisaoReceita {
  compoe: boolean;
  valor: number;
  motivo: string;
  requerRevisao: boolean;
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
  const valor = round2(
    (nota.valorProdutos ?? 0) + (nota.valorServico ?? 0) - (nota.valorDesconto ?? 0),
  );

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
    return { compoe: true, valor, motivo: "Serviço tributado", requerRevisao: false };
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
