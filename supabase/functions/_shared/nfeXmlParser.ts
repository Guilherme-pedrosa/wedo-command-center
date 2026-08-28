/**
 * Parser de XML de NF-e — impostos POR ITEM.
 *
 * Extraído de sync-nfe-entrada/index.ts sem alteração de comportamento, para
 * que precificação e apuração fiscal usem O MESMO parser. Dois parsers de NF-e
 * no mesmo projeto divergem em silêncio e a divergência só aparece na guia.
 *
 * Trata as subtags reais do layout: PISAliq/PISQtde/PISOutr/PISNT,
 * COFINS*, IPITrib/IPINT, ICMS dinâmico (ICMS00..ICMSSN900), pRedBC,
 * ICMS-ST, FCP-ST e DIFAL (ICMSUFDest).
 */

export function getTag(xml: string, tag: string): string {
  const patterns = [
    new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([^<]*)<\\/(?:[a-zA-Z0-9]+:)?${tag}>`, "i"),
    new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, "i"),
  ];
  for (const re of patterns) {
    const m = xml.match(re);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return "";
}

export function getBlock(xml: string, tag: string): string {
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${tag}>`, "i");
  const m = xml.match(re);
  return m?.[1] ?? "";
}

export function getAllBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>[\\s\\S]*?<\\/(?:[a-zA-Z0-9]+:)?${tag}>`, "gi");
  return [...xml.matchAll(re)].map((m) => m[0]);
}

export interface XmlItemTax {
  nItem: number;
  cProd: string;
  cEAN: string;
  cEANTrib: string;
  xProd: string;
  NCM: string;
  CFOP: string;
  qCom: number;
  vProd: number;
  vUnCom: number;
  uCom: string;
  uTrib: string;
  qTrib: number;
  vUnTrib: number;
  vSeg: number;
  vOutro: number;
  vDesc: number;
  icms_orig: string;
  icms_cst: string;
  icms_pRedBC: number;
  icms_vBC: number;
  icms_pICMS: number;
  icms_vICMS: number;
  icms_vICMSST: number;
  icms_vFCPST: number;
  icms_vICMSUFDest: number;
  icms_vICMSUFRemet: number;
  ipi_cst: string;
  ipi_vBC: number;
  ipi_pIPI: number;
  ipi_vIPI: number;
  pis_cst: string;
  pis_vBC: number;
  pis_pPIS: number;
  pis_vPIS: number;
  cofins_cst: string;
  cofins_vBC: number;
  cofins_pCOFINS: number;
  cofins_vCOFINS: number;
  infAdProd: string;
}

export function parseXmlItems(xml: string): XmlItemTax[] {
  const detBlocks = getAllBlocks(xml, "det");
  const items: XmlItemTax[] = [];

  for (const det of detBlocks) {
    const nItemMatch = det.match(/nItem="(\d+)"/i);
    const nItem = nItemMatch ? parseInt(nItemMatch[1]) : items.length + 1;

    const prod = getBlock(det, "prod");
    const imposto = getBlock(det, "imposto");

    const cProd = getTag(prod, "cProd");
    const cEAN = getTag(prod, "cEAN");
    const cEANTrib = getTag(prod, "cEANTrib");
    const xProd = getTag(prod, "xProd");
    const NCM = getTag(prod, "NCM");
    const CFOP = getTag(prod, "CFOP");
    const qCom = parseFloat(getTag(prod, "qCom")) || 1;
    const vProd = parseFloat(getTag(prod, "vProd")) || 0;
    const vUnCom = parseFloat(getTag(prod, "vUnCom")) || 0;
    const uCom = getTag(prod, "uCom");
    const uTrib = getTag(prod, "uTrib");
    const qTrib = parseFloat(getTag(prod, "qTrib")) || 0;
    const vUnTrib = parseFloat(getTag(prod, "vUnTrib")) || 0;
    const vSeg = parseFloat(getTag(prod, "vSeg")) || 0;
    const vOutro = parseFloat(getTag(prod, "vOutro")) || 0;
    const vDesc = parseFloat(getTag(prod, "vDesc")) || 0;

    // ICMS: o nó interno é dinâmico (ICMS00, ICMS40, ICMSSN101, ICMSPart, ...).
    // Busca dinâmica de <orig> em QUALQUER filho, sem fixar CST. Se não existir, fica vazio (=> null no banco).
    const icmsBlock = getBlock(imposto, "ICMS");
    const icmsInner = icmsBlock.trim();
    const icms_orig = getTag(icmsBlock, "orig") || getTag(imposto, "orig");
    const icms_cst = getTag(icmsInner, "CST") || getTag(icmsInner, "CSOSN");

    const icms_pRedBC = parseFloat(getTag(icmsInner, "pRedBC")) || 0;
    const icms_vBC = parseFloat(getTag(icmsInner, "vBC")) || 0;
    const icms_pICMS = parseFloat(getTag(icmsInner, "pICMS")) || 0;
    const icms_vICMS = parseFloat(getTag(icmsInner, "vICMS")) || 0;
    // ICMS-ST e FCP-ST (entram no custo)
    const icms_vICMSST = parseFloat(getTag(icmsInner, "vICMSST")) || 0;
    const icms_vFCPST = parseFloat(getTag(icmsInner, "vFCPST")) || 0;
    // DIFAL (ICMSUFDest)
    const icmsUfDestBlock = getBlock(imposto, "ICMSUFDest");
    const icms_vICMSUFDest = parseFloat(getTag(icmsUfDestBlock, "vICMSUFDest")) || 0;
    const icms_vICMSUFRemet = parseFloat(getTag(icmsUfDestBlock, "vICMSUFRemet")) || 0;

    const ipiBlock = getBlock(imposto, "IPI");
    const ipiTrib = getBlock(ipiBlock, "IPITrib") || ipiBlock;
    const ipi_cst = getTag(ipiTrib, "CST") || getTag(getBlock(ipiBlock, "IPINT"), "CST") || "";
    const ipi_vBC = parseFloat(getTag(ipiTrib, "vBC")) || 0;
    const ipi_pIPI = parseFloat(getTag(ipiTrib, "pIPI")) || 0;
    const ipi_vIPI = parseFloat(getTag(ipiTrib, "vIPI")) || 0;

    const pisBlock = getBlock(imposto, "PIS");
    const pisInner =
      getBlock(pisBlock, "PISAliq") || getBlock(pisBlock, "PISQtde") || getBlock(pisBlock, "PISOutr") || pisBlock;
    const pis_cst = getTag(pisInner, "CST") || getTag(getBlock(pisBlock, "PISNT"), "CST") || "";
    const pis_vBC = parseFloat(getTag(pisInner, "vBC")) || 0;
    const pis_pPIS = parseFloat(getTag(pisInner, "pPIS")) || 0;
    const pis_vPIS = parseFloat(getTag(pisInner, "vPIS")) || 0;

    const cofinsBlock = getBlock(imposto, "COFINS");
    const cofinsInner =
      getBlock(cofinsBlock, "COFINSAliq") ||
      getBlock(cofinsBlock, "COFINSQtde") ||
      getBlock(cofinsBlock, "COFINSOutr") ||
      cofinsBlock;
    const cofins_cst = getTag(cofinsInner, "CST") || getTag(getBlock(cofinsBlock, "COFINSNT"), "CST") || "";
    const cofins_vBC = parseFloat(getTag(cofinsInner, "vBC")) || 0;
    const cofins_pCOFINS = parseFloat(getTag(cofinsInner, "pCOFINS")) || 0;
    const cofins_vCOFINS = parseFloat(getTag(cofinsInner, "vCOFINS")) || 0;

    const infAdProd = getTag(det, "infAdProd");

    items.push({
      nItem, cProd, cEAN, cEANTrib, xProd, NCM, CFOP,
      qCom, vProd, vUnCom,
      uCom, uTrib, qTrib, vUnTrib,
      vSeg, vOutro, vDesc,
      icms_orig, icms_cst, icms_pRedBC, icms_vBC, icms_pICMS, icms_vICMS,
      icms_vICMSST, icms_vFCPST, icms_vICMSUFDest, icms_vICMSUFRemet,
      ipi_cst, ipi_vBC, ipi_pIPI, ipi_vIPI,
      pis_cst, pis_vBC, pis_pPIS, pis_vPIS,
      cofins_cst, cofins_vBC, cofins_pCOFINS, cofins_vCOFINS,
      infAdProd,
    });
  }

  return items;
}

export function getXmlFrete(xml: string): number {
  const infNFe = getBlock(xml, "infNFe") || xml;
  const total = getBlock(infNFe, "total");
  const icmsTot = getBlock(total, "ICMSTot");
  return parseFloat(getTag(icmsTot, "vFrete")) || 0;
}

export function getXmlDescontoTotal(xml: string): number {
  const infNFe = getBlock(xml, "infNFe") || xml;
  const total = getBlock(infNFe, "total");
  const icmsTot = getBlock(total, "ICMSTot");
  return parseFloat(getTag(icmsTot, "vDesc")) || 0;
}

export function getXmlMeta(xml: string): { chave: string; numero_nf: string; data_emissao: string; nome_emitente: string; nat_op: string; inf_cpl: string } {
  const infNFe = getBlock(xml, "infNFe") || xml;
  const ide = getBlock(infNFe, "ide");
  const emit = getBlock(infNFe, "emit");
  const infAdic = getBlock(infNFe, "infAdic");
  // A chave mora no ATRIBUTO Id da tag <infNFe>. getBlock() devolve só o
  // conteúdo interno, sem a tag de abertura — buscar ali sempre dava "".
  // Casa contra o XML inteiro e cai para <chNFe> (presente no protNFe).
  const idMatch =
    xml.match(/<(?:[a-zA-Z0-9]+:)?infNFe[^>]*\bId="NFe([0-9]{44})"/i) ??
    xml.match(/\bId="NFe([0-9]{44})"/i);
  return {
    chave: idMatch?.[1] ?? getTag(xml, "chNFe") ?? "",
    numero_nf: getTag(ide, "nNF"),
    data_emissao: (getTag(ide, "dhEmi") || getTag(ide, "dEmi") || "").slice(0, 10),
    nome_emitente: getTag(emit, "xNome") || getTag(emit, "xFant"),
    nat_op: getTag(ide, "natOp") || "",
    inf_cpl: getTag(infAdic, "infCpl") || "",
  };
}

export function isXmlSimplesNacional(xml: string, xmlItems?: XmlItemTax[]): boolean {
  const emit = getBlock(xml, "emit");
  const crt = getTag(emit, "CRT");
  const crtIsSN = crt === "1" || crt === "2";

  const hasCSOSN = xmlItems?.some(
    (item) =>
      item.icms_cst &&
      /^\d{3}$/.test(item.icms_cst) &&
      ["101", "102", "103", "201", "202", "203", "300", "400", "500", "900"].includes(item.icms_cst),
  );

  const isSNByTag = crtIsSN || !!hasCSOSN;
  if (!isSNByTag && crt) return false;

  if (xmlItems && xmlItems.length > 0) {
    const hasRealTaxes = xmlItems.some((item) => item.icms_vICMS > 0 || item.pis_vPIS > 0 || item.cofins_vCOFINS > 0);
    if (hasRealTaxes) return false;
  }
  return isSNByTag;
}

// ══════════════════════════════════════════════════════════════
//  Complementos para APURAÇÃO FISCAL
// ══════════════════════════════════════════════════════════════

/**
 * CRT do emitente, sem heurística.
 *
 * Diferente de isXmlSimplesNacional(), que é calibrado para precificação e
 * "desqualifica" o Simples quando encontra tributo destacado. Para apuração
 * isso seria perigoso: negaria o resgate da Regra 2.4 a um fornecedor que de
 * fato é do Simples. Aqui devolvemos o que está escrito, e null quando não há
 * como saber — quem decide o que fazer com a ausência é o motor de apuração.
 */
export function getXmlCrt(xml: string): number | null {
  const emit = getBlock(xml, "emit");
  const crt = parseInt(getTag(emit, "CRT"), 10);
  return Number.isFinite(crt) && crt >= 1 && crt <= 4 ? crt : null;
}

/** CSOSN só existe em nota do Simples: serve para recuperar o regime sem a tag CRT. */
export function temCsosn(itens: XmlItemTax[]): boolean {
  return itens.some(
    (i) => i.icms_cst && /^\d{3}$/.test(i.icms_cst) &&
      ["101", "102", "103", "201", "202", "203", "300", "400", "500", "900"].includes(i.icms_cst),
  );
}

export interface XmlEmitente {
  cnpj: string;
  nome: string;
  uf: string;
  crt: number | null;
}

export function getXmlEmitente(xml: string): XmlEmitente {
  const emit = getBlock(xml, "emit");
  return {
    cnpj: getTag(emit, "CNPJ") || getTag(emit, "CPF"),
    nome: getTag(emit, "xNome") || getTag(emit, "xFant"),
    uf: getTag(getBlock(emit, "enderEmit"), "UF"),
    crt: getXmlCrt(xml),
  };
}

export interface XmlTotais {
  vProd: number;
  vFrete: number;
  vDesc: number;
  vIPI: number;
  vICMS: number;
  vST: number;
  vNF: number;
}

export function getXmlTotais(xml: string): XmlTotais {
  const infNFe = getBlock(xml, "infNFe") || xml;
  const total = getBlock(getBlock(infNFe, "total"), "ICMSTot");
  const n = (t: string) => parseFloat(getTag(total, t)) || 0;
  return {
    vProd: n("vProd"),
    vFrete: n("vFrete"),
    vDesc: n("vDesc"),
    vIPI: n("vIPI"),
    vICMS: n("vICMS"),
    vST: n("vST"),
    vNF: n("vNF"),
  };
}

/** Modelo, número, série e datas do bloco <ide>. */
export function getXmlIde(xml: string): { modelo: string; numero: string; serie: string; dataEmissao: string } {
  const infNFe = getBlock(xml, "infNFe") || xml;
  const ide = getBlock(infNFe, "ide");
  return {
    modelo: getTag(ide, "mod") || "55",
    numero: getTag(ide, "nNF"),
    serie: getTag(ide, "serie"),
    dataEmissao: (getTag(ide, "dhEmi") || getTag(ide, "dEmi") || "").slice(0, 10),
  };
}

// ══════════════════════════════════════════════════════════════
//  NFS-e (ABRASF) — nota de servico municipal
// ══════════════════════════════════════════════════════════════

/**
 * Igual a getBlock, mas com o nome da tag ANCORADO.
 *
 * getBlock("Prestador") casa com <PrestadorServico>, porque o [^>]* engole o
 * resto do nome. Na NFS-e isso importa: <Prestador> guarda o CNPJ e
 * <PrestadorServico> guarda razao social e endereco, sao blocos diferentes.
 * O parser de NF-e continua usando getBlock para nao mudar comportamento em
 * producao.
 */
export function getBlockExato(xml: string, tag: string): string {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${tag}(?=[\\s/>])[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${tag}>`,
    "i",
  );
  return xml.match(re)?.[1] ?? "";
}

/** Reconhece um XML de NFS-e no padrao ABRASF. */
export function ehNfse(xml: string): boolean {
  return /<(?:[a-zA-Z0-9]+:)?(InfNfse|CompNfse|Nfse)\b/i.test(xml);
}

export interface NfseParsed {
  numero: string;
  codigoVerificacao: string;
  dataEmissao: string;
  prestadorCnpj: string;
  prestadorNome: string;
  tomadorCnpj: string;
  tomadorNome: string;
  tomadorUf: string;
  discriminacao: string;
  itemListaServico: string;
  valorServicos: number;
  valorDeducoes: number;
  valorLiquido: number;
  baseCalculo: number;
  aliquotaIss: number;
  valorIss: number;
  /** ABRASF: 1 = ISS retido pelo tomador, 2 = nao retido. */
  issRetido: number;
  valorPis: number;
  valorCofins: number;
  valorInss: number;
  valorIr: number;
  valorCsll: number;
  cancelada: boolean;
}

export function parseNfse(xml: string): NfseParsed | null {
  const inf = getBlock(xml, "InfNfse");
  if (!inf) return null;

  const valoresNfse = getBlock(inf, "ValoresNfse");
  const servico = getBlock(inf, "Servico");
  const valoresServico = getBlock(servico, "Valores");
  const prestador = getBlock(inf, "PrestadorServico");
  const tomador = getBlock(inf, "TomadorServico");

  const n = (bloco: string, t: string) => parseFloat(getTag(bloco, t)) || 0;
  // O documento repete valores em ValoresNfse e em Servico/Valores; o de
  // Servico e o declarado pelo prestador, o de ValoresNfse e o consolidado.
  const num2 = (t: string) => n(valoresServico, t) || n(valoresNfse, t);

  const cancelada = /<(?:[a-zA-Z0-9]+:)?NfseCancelamento\b/i.test(xml)
    || /<(?:[a-zA-Z0-9]+:)?Cancelamento\b/i.test(xml);

  return {
    numero: getTag(inf, "Numero"),
    codigoVerificacao: getTag(inf, "CodigoVerificacao"),
    dataEmissao: getTag(inf, "DataEmissao").slice(0, 10),
    // O CNPJ do prestador mora em <Prestador><CpfCnpj><Cnpj>, um bloco
    // diferente de <PrestadorServico>, que so tem razao social e endereco.
    prestadorCnpj:
      getTag(getBlockExato(inf, "Prestador"), "Cnpj")
      || getTag(getBlockExato(inf, "IdentificacaoPrestador"), "Cnpj")
      || getTag(getBlockExato(prestador, "CpfCnpj"), "Cnpj"),
    prestadorNome: getTag(prestador, "RazaoSocial"),
    tomadorCnpj: getTag(getBlock(tomador, "IdentificacaoTomador"), "Cnpj")
      || getTag(tomador, "Cnpj") || getTag(tomador, "Cpf"),
    tomadorNome: getTag(tomador, "RazaoSocial"),
    tomadorUf: getTag(getBlock(tomador, "Endereco"), "Uf"),
    discriminacao: getTag(servico, "Discriminacao")
      || getTag(inf, "DescricaoCodigoTributacaoMunicipio"),
    itemListaServico: getTag(servico, "ItemListaServico"),
    valorServicos: num2("ValorServicos"),
    valorDeducoes: num2("ValorDeducoes"),
    valorLiquido: n(valoresNfse, "ValorLiquidoNfse") || num2("ValorLiquidoNfse"),
    baseCalculo: n(valoresNfse, "BaseCalculo") || num2("BaseCalculo"),
    aliquotaIss: n(valoresNfse, "Aliquota") || num2("Aliquota"),
    valorIss: n(valoresNfse, "ValorIss") || num2("ValorIss"),
    issRetido: parseInt(getTag(valoresServico, "IssRetido") || getTag(servico, "IssRetido"), 10) || 0,
    valorPis: num2("ValorPis"),
    valorCofins: num2("ValorCofins"),
    valorInss: num2("ValorInss"),
    valorIr: num2("ValorIr"),
    valorCsll: num2("ValorCsll"),
    cancelada,
  };
}
