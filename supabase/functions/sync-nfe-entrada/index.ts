// ══════════════════════════════════════════════════════════════
//  sync-nfe-entrada — Matcher determinístico (CNPJ + nº NF)
//  v2: zero chamadas à API GC. Lê gc_compras + gc_compras_itens
//      locais e casa com fin_nfe_xml_index pelo par
//      (cnpj_emitente, numero_nf). Fallback: cnpj + valor.
//      Compras sem match são registradas em fin_nfe_match_pendentes.
// ══════════════════════════════════════════════════════════════
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Regras que o matcher ATUAL escreve como "match real" (com preço/tributo do XML).
// Regras posicionais legadas (ex.: `pedido_compra_gc+ordem_gc_xml`) NÃO devem
// contar — elas ficaram gravadas quando o código antigo assumia compra[i]↔xml[i]
// e produziam vínculos absurdos. Manter essa lista sincronizada com os `rule`
// que aparecem em `pedido_compra_gc+${rule}` mais abaixo.
const CURRENT_REAL_MATCH_RULES = new Set([
  "cprod",
  "cprod_multi",
  "cprod_normalizado",
  "codigo_interno_xprod",
  "ean",
  "nome_preco",
  "preco_qtd_exato",
  "residual_1x1",
  "residual_preco",
  "unico",
]);
function isRealCurrentMatchRule(rule: string): boolean {
  if (!rule.startsWith("pedido_compra_gc+")) return false;
  // Corta o "+pack:Nx" opcional pra comparar só o rule base.
  const base = rule.slice("pedido_compra_gc+".length).split("+")[0];
  return CURRENT_REAL_MATCH_RULES.has(base);
}


// ── Types locais ──
interface CompraItem {
  item_gc_id: string | null;
  produto_gc_id: string | null;
  nome_produto: string;
  quantidade: number;
  valor_custo: number;
  valor_total: number;
  unidade: string | null;
  origem_vinculo: string | null;
  ordem_item: number | null;
}

interface CompraRow {
  gc_id: string;
  codigo: string;
  numero_nfe: string | null;
  cnpj_fornecedor: string | null;
  fornecedor_id: string | null;
  nome_fornecedor: string;
  data: string | null;
  valor_total: number;
  valor_produtos: number;
  valor_frete: number;
  itens: CompraItem[];
}

interface XmlIndexRow {
  chave: string;
  numero_nf: string | null;
  cnpj_emitente: string | null;
  nome_emitente: string | null;
  data_emissao: string | null;
  valor_total: number | null;
  valor_produtos: number | null;
  qtd_itens: number | null;
  storage_path: string | null;
}

interface ProductTaxRecord {
  gc_produto_id: string;
  nome_produto: string;
  ncm: string;
  cfop: string;
  nf_gc_id: string;
  nf_numero: string;
  nf_chave: string;
  nf_data_emissao: string;
  compra_gc_id: string;
  compra_codigo: string;
  fornecedor_nome: string;
  regime_fornecedor: string;
  sem_credito: boolean;
  icms_aliquota: number;
  icms_base: number;
  pis_aliquota: number;
  cofins_aliquota: number;
  ipi_aliquota: number;
  frete_percentual: number;
  valor_unitario_nf: number;
  valor_icms_unit: number;
  valor_pis_unit: number;
  valor_cofins_unit: number;
  valor_ipi_unit: number;
  valor_frete_unit: number;
  custo_efetivo_unit: number;
  match_rule: string;
  descricao_nf: string;
  unidade_comercial_nf: string;
  unidade_tributavel_nf: string;
  // Bloco 1.9: campos extras de NF para cálculo real
  q_com: number;
  v_un_com: number;
  q_trib: number;
  v_un_trib: number;
  fator_conversao: number;
  fator_embalagem: number;
  v_seg: number;
  v_outro: number;
  v_desc: number;
  v_icms_st: number;
  v_fcp_st: number;
  v_icms_uf_dest: number;
  v_icms_uf_remet: number;
  custo_variavel_real: number;
}

// ══════════════════════════════════════════════════════════════
//  XML PARSER — impostos POR ITEM do XML real da NF-e
// ══════════════════════════════════════════════════════════════
function getTag(xml: string, tag: string): string {
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

function getBlock(xml: string, tag: string): string {
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${tag}>`, "i");
  const m = xml.match(re);
  return m?.[1] ?? "";
}

function getAllBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>[\\s\\S]*?<\\/(?:[a-zA-Z0-9]+:)?${tag}>`, "gi");
  return [...xml.matchAll(re)].map((m) => m[0]);
}

interface XmlItemTax {
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
}

function parseXmlItems(xml: string): XmlItemTax[] {
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

    const icmsBlock = getBlock(imposto, "ICMS");
    const icmsInner = icmsBlock.replace(/<\/?(?:[a-zA-Z0-9]+:)?ICMS>/gi, "").trim();
    const icms_orig = getTag(icmsInner, "orig");
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
    });
  }

  return items;
}

function getXmlFrete(xml: string): number {
  const infNFe = getBlock(xml, "infNFe") || xml;
  const total = getBlock(infNFe, "total");
  const icmsTot = getBlock(total, "ICMSTot");
  return parseFloat(getTag(icmsTot, "vFrete")) || 0;
}

function getXmlMeta(xml: string): { chave: string; numero_nf: string; data_emissao: string; nome_emitente: string } {
  const infNFe = getBlock(xml, "infNFe") || xml;
  const ide = getBlock(infNFe, "ide");
  const emit = getBlock(infNFe, "emit");
  const idMatch = (getBlock(xml, "infNFe") || "").match(/Id="NFe([0-9]{44})"/i);
  return {
    chave: idMatch?.[1] ?? "",
    numero_nf: getTag(ide, "nNF"),
    data_emissao: (getTag(ide, "dhEmi") || getTag(ide, "dEmi") || "").slice(0, 10),
    nome_emitente: getTag(emit, "xNome") || getTag(emit, "xFant"),
  };
}

function isXmlSimplesNacional(xml: string, xmlItems?: XmlItemTax[]): boolean {
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
//  Utilidades
// ══════════════════════════════════════════════════════════════
function normCnpj(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}
function normNumeroNf(v: string | null | undefined): string {
  return ((v ?? "").replace(/\D/g, "")).replace(/^0+/, "");
}
function normalizarCodigoProduto(c: string | null | undefined): string {
  if (!c) return "";
  return String(c).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function stripLeadingZerosCode(code: string): string {
  if (!/^[0-9]+$/.test(code)) return code;
  return code.replace(/^0+/, "") || "0";
}

function codigoComparavel(raw: string | null | undefined): string[] {
  const norm = normalizarCodigoProduto(raw);
  if (!norm || /^0+$/.test(norm)) return [];
  const out = new Set<string>([norm, stripLeadingZerosCode(norm)]);
  return [...out].filter((c) => c.length >= 4);
}

function normalizarCodigoBarra(raw: string | null | undefined): string {
  const norm = normalizarCodigoProduto(raw);
  if (!norm || norm === "SEMGTIN" || norm === "SEMGTINTRIB") return "";
  const comparable = stripLeadingZerosCode(norm);
  return comparable.length >= 6 ? comparable : "";
}

function addMapValue(map: Map<string, number[]>, key: string, value: number) {
  if (!key) return;
  const arr = map.get(key) || [];
  arr.push(value);
  map.set(key, arr);
}

function extractProductCodesFromText(text: string | null | undefined): string[] {
  const raw = String(text ?? "").toUpperCase();
  const out = new Set<string>();

  // Captura códigos compostos antes de quebrar pontuação: "76511/02" -> "7651102".
  for (const match of raw.matchAll(/[A-Z0-9]+(?:[./_-]+[A-Z0-9]+)+/g)) {
    for (const c of codigoComparavel(match[0])) out.add(c);
  }

  for (const token of normalizeText(raw).split(/\s+/)) {
    // Não trata pedaços de códigos compostos como equivalentes.
    // Ex.: "76511/02" NÃO deve casar com cadastro "76511".
    if (raw.includes(`${token}/`) || raw.includes(`${token}-`) || raw.includes(`${token}.`) || raw.includes(`${token}_`)) {
      continue;
    }
    if (/^[A-Z0-9]{4,}$/.test(token)) {
      for (const c of codigoComparavel(token)) out.add(c);
    }
  }
  return [...out];
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

async function tryDownloadXml(chave: string, storagePath: string | null, supabase: any): Promise<string | null> {
  if (!chave || chave.length < 44) return null;
  const candidates = [
    storagePath || "",
    `${chave}.xml`,
    `NF-e${chave}.xml`,
    `NFe${chave}.xml`,
    `nfe-${chave}.xml`,
  ].filter(Boolean);
  for (const path of candidates) {
    const { data, error } = await supabase.storage.from("nf-xmls").download(path);
    if (!error && data) {
      const text = await data.text();
      if (text && (text.includes("<nfeProc") || text.includes("<NFe") || text.includes("<infNFe"))) {
        return text;
      }
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
//  Reindex delta: lista o bucket nf-xmls e indexa o que faltar
// ══════════════════════════════════════════════════════════════
function parseXmlMetadataText(text: string) {
  const chaveMatch = text.match(/Id="NFe(\d{44})"/i) || text.match(/chNFe>(\d{44})</i);
  const chave = chaveMatch?.[1] || null;
  const numeroNfMatch = text.match(/<nNF[^>]*>([^<]+)<\/nNF>/i);
  const numero_nf = numeroNfMatch?.[1]?.trim() || null;
  const emitMatch = text.match(/<emit[^>]*>([\s\S]*?)<\/emit>/i);
  const emitBlock = emitMatch?.[1] || "";
  const cnpjMatch = emitBlock.match(/<CNPJ[^>]*>(\d+)<\/CNPJ>/i);
  const cnpj_emitente = cnpjMatch?.[1] || null;
  const nomeMatch = emitBlock.match(/<xNome[^>]*>([^<]+)<\/xNome>/i);
  const nome_emitente = nomeMatch?.[1] || null;
  const dhEmiMatch = text.match(/<dhEmi[^>]*>([^<]+)<\/dhEmi>/i) || text.match(/<dEmi[^>]*>([^<]+)<\/dEmi>/i);
  const data_emissao = dhEmiMatch?.[1]?.substring(0, 10) || null;
  const totalBlock = text.match(/<total[^>]*>[\s\S]*?<\/total>/i)?.[0] || text;
  const icmsTotBlock = totalBlock.match(/<ICMSTot[^>]*>[\s\S]*?<\/ICMSTot>/i)?.[0] || totalBlock;
  const vNFMatch = icmsTotBlock.match(/<vNF[^>]*>([^<]+)<\/vNF>/i);
  const valor_total = vNFMatch ? parseFloat(vNFMatch[1]) : null;
  // Importante: no XML há <prod><vProd> por item. Aqui precisa ser o total da NF
  // (<total><ICMSTot><vProd>), senão o índice fica com o valor do primeiro item.
  const vProdMatch = icmsTotBlock.match(/<vProd[^>]*>([^<]+)<\/vProd>/i);
  const valor_produtos = vProdMatch ? parseFloat(vProdMatch[1]) : null;
  const detMatches = text.match(/<det /gi) || text.match(/<det>/gi) || [];
  const qtd_itens = detMatches.length;
  return { chave, numero_nf, cnpj_emitente, nome_emitente, data_emissao, valor_total, valor_produtos, qtd_itens };
}

function valorCompraSemFrete(compra: CompraRow): number {
  if (compra.valor_produtos > 0) return compra.valor_produtos;
  if (compra.valor_total > 0 && compra.valor_frete > 0) return compra.valor_total - compra.valor_frete;
  return 0;
}

function diffCompraXml(compra: CompraRow, xml: XmlIndexRow): { diff: number; base: number; rule: string } {
  const compraTotal = compra.valor_total || 0;
  const compraProdutos = valorCompraSemFrete(compra);
  const xmlTotal = Number(xml.valor_total) || 0;
  const xmlProdutos = Number(xml.valor_produtos) || 0;
  const combos = [
    { compra: compraTotal, xml: xmlTotal, rule: "total_vs_total" },
    { compra: compraProdutos, xml: xmlTotal, rule: "produtos_compra_vs_total_nf" },
    { compra: compraProdutos, xml: xmlProdutos, rule: "produtos_vs_produtos" },
    { compra: compraTotal, xml: xmlProdutos, rule: "total_compra_vs_produtos_nf" },
  ].filter((c) => c.compra > 0 && c.xml > 0);

  let best = { diff: Infinity, base: Math.max(compraTotal, compraProdutos, 1), rule: "sem_valor_comparavel" };
  for (const c of combos) {
    const diff = Math.abs(c.xml - c.compra);
    if (diff < best.diff) best = { diff, base: c.compra, rule: c.rule };
  }
  return best;
}

async function listBucketRecursive(supabase: any, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  let page = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase.storage.from("nf-xmls").list(prefix, {
      limit: pageSize,
      offset: page * pageSize,
      sortBy: { column: "name", order: "asc" },
    });
    if (error || !data || data.length === 0) break;
    for (const item of data) {
      const full = prefix ? `${prefix}/${item.name}` : item.name;
      // pasta (id null) → recursão
      if (!item.id && !item.metadata) {
        const nested = await listBucketRecursive(supabase, full);
        out.push(...nested);
      } else if (full.toLowerCase().endsWith(".xml")) {
        out.push(full);
      }
    }
    if (data.length < pageSize) break;
    page++;
  }
  return out;
}

async function reindexBucketDelta(supabase: any) {
  const stats = { listed: 0, missing: 0, indexed: 0, failed: 0 };

  // Conjunto de storage_paths já indexados
  const known = new Set<string>();
  {
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("fin_nfe_xml_index")
        .select("storage_path")
        .range(from, from + pageSize - 1);
      if (error || !data || data.length === 0) break;
      for (const row of data) if (row.storage_path) known.add(String(row.storage_path));
      if (data.length < pageSize) break;
      from += pageSize;
    }
  }

  const allFiles = await listBucketRecursive(supabase);
  stats.listed = allFiles.length;

  const missing = allFiles.filter((p) => !known.has(p));
  stats.missing = missing.length;

  // Cap por chamada para caber no timeout (~60s).
  // Além dos XMLs novos, refresca parte dos já conhecidos: versões antigas do
  // indexador gravavam valor_produtos usando o <vProd> do primeiro item.
  const cap = 600;
  const refreshKnown = allFiles.filter((p) => known.has(p)).slice(0, Math.min(25, Math.max(0, cap - missing.length)));
  const toProcess = [...missing.slice(0, cap), ...refreshKnown];
  const batchSize = 25;
  const upsertBuffer: Record<string, unknown>[] = [];

  for (let i = 0; i < toProcess.length; i += batchSize) {
    const batch = toProcess.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (path) => {
        try {
          const { data, error } = await supabase.storage.from("nf-xmls").download(path);
          if (error || !data) {
            stats.failed++;
            return;
          }
          const text = await data.text();
          const meta = parseXmlMetadataText(text);
          if (!meta.chave) {
            stats.failed++;
            return;
          }
          upsertBuffer.push({
            chave: meta.chave,
            cnpj_emitente: meta.cnpj_emitente,
            nome_emitente: meta.nome_emitente,
            data_emissao: meta.data_emissao,
            valor_total: meta.valor_total,
            valor_produtos: meta.valor_produtos,
            qtd_itens: meta.qtd_itens,
            storage_path: path,
          });
        } catch (_e) {
          stats.failed++;
        }
      }),
    );

    if (upsertBuffer.length >= 100) {
      const toUpsert = upsertBuffer.splice(0, upsertBuffer.length);
      const { error } = await supabase
        .from("fin_nfe_xml_index")
        .upsert(toUpsert as any, { onConflict: "chave" });
      if (!error) stats.indexed += toUpsert.length;
      else stats.failed += toUpsert.length;
    }
  }

  if (upsertBuffer.length > 0) {
    const { error } = await supabase
      .from("fin_nfe_xml_index")
      .upsert(upsertBuffer as any, { onConflict: "chave" });
    if (!error) stats.indexed += upsertBuffer.length;
    else stats.failed += upsertBuffer.length;
  }

  return stats;
}

// ══════════════════════════════════════════════════════════════
//  HTTP handler
// ══════════════════════════════════════════════════════════════
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const inicio = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const offset = Number(body.offset) || 0;
    const batchSize = Math.min(Number(body.batch_size) || 50, 200);
    const dryRun = body.dry_run === true;
    const compraCodigosFilter: string[] = Array.isArray(body.compra_codigos)
      ? body.compra_codigos.map((c: any) => String(c))
      : [];
    const dataInicio: string | null = typeof body.data_inicio === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.data_inicio)
      ? body.data_inicio : null;
    const dataFim: string | null = typeof body.data_fim === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.data_fim)
      ? body.data_fim : null;
    const apenasSemNf = body.apenas_sem_nf === true;

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ── Step 0: Reindex delta do bucket nf-xmls ──
    // Lista o bucket e indexa todo XML que ainda não está em fin_nfe_xml_index.
    // Garante que o "Cruzar Pedidos" sempre opere sobre o estado mais recente do bucket.
    const skipReindex = body.skip_reindex === true;
    let reindexStats = { listed: 0, missing: 0, indexed: 0, failed: 0 };
    if (!skipReindex && offset === 0) {
      reindexStats = await reindexBucketDelta(supabase);
    }

    // ── Filtro opcional: compras sem tributo NF gravado ainda ──
    let compraIdsSemNf: Set<string> | null = null;
    if (apenasSemNf) {
      const jaComNf = new Set<string>();
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("fin_produto_tributos")
          .select("compra_gc_id")
          .not("nf_chave", "is", null)
          .neq("nf_chave", "")
          .range(from, from + pageSize - 1);
        if (error || !data || data.length === 0) break;
        for (const r of data) if (r.compra_gc_id) jaComNf.add(String(r.compra_gc_id));
        if (data.length < pageSize) break;
        from += pageSize;
      }
      compraIdsSemNf = jaComNf; // usado como "excluir estes"
    }

    // ── Step 1: Carrega compras candidatas.
    // Algumas compras do GC vêm com NF-e visível na UI, mas numero_nfe vazio no payload local;
    // nesses casos ainda cruzamos por CNPJ + valor total contra o XML indexado.
    const applyFilters = (q: any) => {
      let query = q;
      if (compraCodigosFilter.length > 0) query = query.in("codigo", compraCodigosFilter);
      if (dataInicio) query = query.gte("data", dataInicio);
      if (dataFim) query = query.lte("data", dataFim);
      if (compraIdsSemNf && compraIdsSemNf.size > 0) {
        query = query.not("gc_id", "in", `(${[...compraIdsSemNf].map((v) => `"${v}"`).join(",")})`);
      }
      return query;
    };

    const { count: totalCount, error: countErr } = await applyFilters(
      supabase.from("gc_compras").select("*", { count: "exact", head: true })
    );
    if (countErr) throw new Error(`count compras: ${countErr.message}`);

    const totalCompras = totalCount ?? 0;

    const { data: comprasRaw, error: comprasErr } = await applyFilters(
      supabase
        .from("gc_compras")
        .select("gc_id, codigo, numero_nfe, cnpj_fornecedor, fornecedor_id, nome_fornecedor, data, valor_total, valor_produtos, valor_frete")
        .order("data", { ascending: false, nullsFirst: false })
        .range(offset, offset + batchSize - 1)
    );
    if (comprasErr) throw new Error(`select compras: ${comprasErr.message}`);


    const compraIds = (comprasRaw || []).map((c: any) => String(c.gc_id));
    const hasMore = offset + batchSize < totalCompras;

    if (compraIds.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          total_compras: totalCompras,
          processed: 0,
          has_more: false,
          next_offset: 0,
          reindex_stats: reindexStats,
          tempo_ms: Date.now() - inicio,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Step 2: Itens das compras ──
    const itensByCompra = new Map<string, CompraItem[]>();
    for (let i = 0; i < compraIds.length; i += 100) {
      const chunk = compraIds.slice(i, i + 100);
      const { data: itens } = await supabase
        .from("gc_compras_itens")
        .select("compra_gc_id, item_gc_id, produto_gc_id, nome_produto, quantidade, valor_custo, valor_total, unidade, origem_vinculo, ordem_item")
        .in("compra_gc_id", chunk);
      for (const it of itens || []) {
        const arr = itensByCompra.get(String(it.compra_gc_id)) || [];
        arr.push({
          item_gc_id: it.item_gc_id ?? null,
          produto_gc_id: it.produto_gc_id,
          nome_produto: it.nome_produto || "",
          quantidade: Number(it.quantidade) || 1,
          valor_custo: Number(it.valor_custo) || 0,
          valor_total: Number(it.valor_total) || 0,
          unidade: it.unidade,
          origem_vinculo: it.origem_vinculo,
          ordem_item: it.ordem_item != null ? Number(it.ordem_item) : null,
        });
        itensByCompra.set(String(it.compra_gc_id), arr);
      }
    }
    // garante ordem estável por ordem_item (fallback: ordem de inserção)
    for (const [k, arr] of itensByCompra) {
      arr.sort((a, b) => (a.ordem_item ?? 999999) - (b.ordem_item ?? 999999));
      itensByCompra.set(k, arr);
    }

    const compras: CompraRow[] = (comprasRaw || []).map((c: any) => ({
      gc_id: String(c.gc_id),
      codigo: c.codigo || "",
      numero_nfe: c.numero_nfe,
      cnpj_fornecedor: c.cnpj_fornecedor,
      fornecedor_id: c.fornecedor_id,
      nome_fornecedor: c.nome_fornecedor || "",
      data: c.data,
      valor_total: Number(c.valor_total) || 0,
      valor_produtos: Number(c.valor_produtos) || 0,
      valor_frete: Number(c.valor_frete) || 0,
      itens: itensByCompra.get(String(c.gc_id)) || [],
    }));

    // ── Step 3: Carrega índice de XMLs (cabe em RAM) — pagina para evitar limite de 1000 ──
    const xmlIndex: XmlIndexRow[] = [];
    {
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("fin_nfe_xml_index")
          .select("chave, numero_nf, cnpj_emitente, nome_emitente, data_emissao, valor_total, valor_produtos, qtd_itens, storage_path")
          .range(from, from + pageSize - 1);
        if (error) throw new Error(`select xml_index: ${error.message}`);
        if (!data || data.length === 0) break;
        xmlIndex.push(...(data as XmlIndexRow[]));
        if (data.length < pageSize) break;
        from += pageSize;
      }
    }


    const byKey = new Map<string, XmlIndexRow[]>(); // key = cnpj|numero
    const byCnpj = new Map<string, XmlIndexRow[]>();
    for (const xi of (xmlIndex || []) as XmlIndexRow[]) {
      const cnpj = normCnpj(xi.cnpj_emitente);
      if (!cnpj) continue;
      const num = normNumeroNf(xi.numero_nf);
      if (num) {
        const k = `${cnpj}|${num}`;
        const arr = byKey.get(k) || [];
        arr.push(xi);
        byKey.set(k, arr);
      }
      const c = byCnpj.get(cnpj) || [];
      c.push(xi);
      byCnpj.set(cnpj, c);
    }

    // ── Step 3.5: Preload codigo_interno/codigo_barra dos produtos da compra (fonte do vínculo pedido↔NF item) ──
    const allProdIds = Array.from(
      new Set(
        compras.flatMap((c) => c.itens.map((i) => i.produto_gc_id).filter(Boolean) as string[]),
      ),
    );
    const codigoPorProdutoId = new Map<string, string>();
    const codigoBarraPorProdutoId = new Map<string, string>();
    for (let i = 0; i < allProdIds.length; i += 200) {
      const chunk = allProdIds.slice(i, i + 200);
      const { data: prods } = await supabase
        .from("gc_produtos_cache")
        .select("produto_gc_id, codigo_interno, codigo_barra")
        .in("produto_gc_id", chunk);
      for (const p of prods || []) {
        const norm = normalizarCodigoProduto(p.codigo_interno);
        if (norm) codigoPorProdutoId.set(String(p.produto_gc_id), norm);
        const ean = normalizarCodigoBarra(p.codigo_barra);
        if (ean) codigoBarraPorProdutoId.set(String(p.produto_gc_id), ean);
      }
    }

    // ── Step 4: NÃO deleta tributos antigos — apenas upsert por gc_produto_id ──
    // Antes: DELETE atacado wipeava tributos que não fossem re-inseridos nesta rodada,
    // fazendo sumir NFs vinculadas quando o XML não estava no índice atual.
    // Agora só limpa pendências (reprocessadas a cada rodada).
    if (offset === 0 && !dryRun && compraCodigosFilter.length === 0) {
      // Preserva pendências de custo zero (criadas pela migration / fora do escopo do matcher de NF)
      await supabase.from("fin_nfe_match_pendentes").delete().neq("motivo", "custo_zero_no_cadastro_gc");
    }

    // ── Step 5: Matcher determinístico ──
    const productTaxMap = new Map<string, ProductTaxRecord>();
    const pendentesNovos: any[] = [];
    const descartesPicker: any[] = [];
    let nivel1 = 0;
    let nivel2 = 0;
    let semMatch = 0;
    let xmlsLidos = 0;
    let xmlsFalha = 0;
    const semMatchAmostra: any[] = [];

    // Limpa descartes anteriores só no primeiro lote pra permitir análise limpa por rodada
    if (offset === 0 && !dryRun) {
      await supabase.from("fin_nfe_picker_descartes").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    }

    for (const compra of compras) {
      let cnpj = normCnpj(compra.cnpj_fornecedor);
      const numero = normNumeroNf(compra.numero_nfe);

      // Fallback CNPJ: se o pedido veio sem CNPJ (fornecedor não cadastrado em fin_fornecedores),
      // tenta descobrir via nome_fornecedor vs nome_emitente dos XMLs indexados.
      if (!cnpj && compra.nome_fornecedor) {
        const STOP = new Set(["LTDA","EIRELI","EPP","ME","SA","MEI","INDUSTRIA","COMERCIO","COMERCIAL","SERVICOS","DISTRIBUIDORA","IMPORTACAO","EXPORTACAO","LIMITADA","DE","DA","DO","DOS","DAS","E"]);
        const clean = (s: string) => normalizeText(s).split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
        const tokensAlvo = clean(compra.nome_fornecedor);
        if (tokensAlvo.length > 0) {
          const cnpjScore = new Map<string, number>();
          for (const x of xmlIndex) {
            if (!x.cnpj_emitente || !x.nome_emitente) continue;
            const tokensXml = new Set(clean(x.nome_emitente));
            const comuns = tokensAlvo.filter((t) => tokensXml.has(t)).length;
            const minReq = tokensAlvo.length === 1 ? 1 : 2;
            if (comuns >= minReq) {
              cnpjScore.set(x.cnpj_emitente, Math.max(cnpjScore.get(x.cnpj_emitente) || 0, comuns));
            }
          }
          if (cnpjScore.size === 1) {
            cnpj = [...cnpjScore.keys()][0];
          } else if (cnpjScore.size > 1) {
            const ordered = [...cnpjScore.entries()].sort((a, b) => b[1] - a[1]);
            // aceita o melhor se estritamente > que o segundo (evita ambiguidade)
            if (ordered[0][1] > ordered[1][1]) cnpj = ordered[0][0];
          }
        }
      }


      if (!cnpj) {
        semMatch++;
        registrarPendente(pendentesNovos, semMatchAmostra, compra, "sem_cnpj_compra", []);
        continue;
      }

      let matched: XmlIndexRow | null = null;
      let matchRuleTag = "";
      if (numero) {
        // Nível 1: cnpj + numero
        const exatos = byKey.get(`${cnpj}|${numero}`) || [];
        if (exatos.length === 1) {
          matched = exatos[0];
          matchRuleTag = "deterministico_cnpj_numero";
          nivel1++;
        } else if (exatos.length > 1) {
          // Desempate por menor diff de valor
          let best = exatos[0];
          let bestDiff = Infinity;
          for (const x of exatos) {
            const diff = Math.abs((x.valor_total || 0) - compra.valor_total);
            if (diff < bestDiff) {
              bestDiff = diff;
              best = x;
            }
          }
          matched = best;
          matchRuleTag = "deterministico_cnpj_numero_multi";
          nivel1++;
        }
      }

      if (!matched) {
        // Nível 2: cnpj + valor (tolerância 1% ou R$5).
        // Com frete lançado separado no pedido GC, a NF pode bater com
        // valor_produtos do pedido, não com valor_total.
        const candidatos = byCnpj.get(cnpj) || [];
        if (candidatos.length === 0) {
          semMatch++;
          registrarPendente(pendentesNovos, semMatchAmostra, compra, "cnpj_sem_xml", []);
          continue;
        }
        const compraBaseTol = Math.max(compra.valor_total || 0, valorCompraSemFrete(compra));
        const tol = Math.max(compraBaseTol * 0.01, 5);
        let best: XmlIndexRow | null = null;
        let bestDiff = Infinity;
        let bestRule = "";
        for (const x of candidatos) {
          const valMatch = diffCompraXml(compra, x);
          if (valMatch.diff <= tol && valMatch.diff < bestDiff) {
            bestDiff = valMatch.diff;
            bestRule = valMatch.rule;
            best = x;
          }
        }
        if (best) {
          matched = best;
          matchRuleTag = `cnpj_valor_frouxo:${bestRule}`;
          nivel2++;
        } else {
          semMatch++;
          const top3 = candidatos
            .slice()
            .sort(
              (a, b) =>
                diffCompraXml(compra, a).diff - diffCompraXml(compra, b).diff,
            )
            .slice(0, 3)
            .map((x) => {
              const valMatch = diffCompraXml(compra, x);
              return {
                chave: x.chave,
                numero_nf: x.numero_nf,
                valor_total: x.valor_total,
                valor_produtos: x.valor_produtos,
                data_emissao: x.data_emissao,
                diff: valMatch.diff,
                diff_rule: valMatch.rule,
              };
            });
          registrarPendente(pendentesNovos, semMatchAmostra, compra, "valor_fora_tolerancia", top3);
          continue;
        }
      }

      if (!matched) continue;

      // ── Baixa XML e processa ──
      const xml = await tryDownloadXml(matched.chave, matched.storage_path, supabase);
      if (!xml) {
        xmlsFalha++;
        semMatch++;
        registrarPendente(pendentesNovos, semMatchAmostra, compra, "cnpj_sem_xml", [
          { chave: matched.chave, motivo: "xml_nao_encontrado_no_bucket" },
        ]);
        continue;
      }
      xmlsLidos++;

      processarXml(xml, matched, compra, matchRuleTag, productTaxMap, codigoPorProdutoId, codigoBarraPorProdutoId, descartesPicker);
    }

    // ── Step 6: Upsert tributos ──
    //  GUARDA ANTI-REGRESSÃO: nunca sobrescrever uma NF já gravada por outra mais antiga.
    //  Como o matcher pagina compras por data desc em batches, sem essa guarda um batch
    //  de compras antigas poderia chegar depois e jogar fora a NF mais recente.
    let upserted = 0;
    let skippedOlder = 0;
    if (!dryRun && productTaxMap.size > 0) {
      const ids = [...productTaxMap.keys()];
      const manuais = new Set<string>();
      const excecoes = new Set<string>();
      const existingNfDate = new Map<string, string>();
      const existingHasRealMatch = new Set<string>();
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const { data } = await supabase
          .from("fin_produto_tributos")
          .select("gc_produto_id, icms_aliquota_manual, pis_aliquota_manual, cofins_aliquota_manual, ipi_aliquota_manual, nf_data_emissao, match_rule, excecao_manual")
          .in("gc_produto_id", chunk);
        for (const row of data || []) {
          if (
            row.icms_aliquota_manual != null ||
            row.pis_aliquota_manual != null ||
            row.cofins_aliquota_manual != null ||
            row.ipi_aliquota_manual != null
          )
            manuais.add(row.gc_produto_id);
          if (row.excecao_manual === true) excecoes.add(row.gc_produto_id);
          if (row.nf_data_emissao) existingNfDate.set(row.gc_produto_id, String(row.nf_data_emissao));
          // Só considera "match real" as regras que o matcher ATUAL escreve.
          // Regras legadas como `+ordem_gc_xml` (heurística posicional removida) NÃO
          // contam — se contassem, um vínculo posicional errado ficaria eterno,
          // pois a guarda descartaria toda nova tentativa que caísse em `sem_xml_item`.
          if (row.match_rule && isRealCurrentMatchRule(String(row.match_rule))) {
            existingHasRealMatch.add(row.gc_produto_id);
          }
        }
      }
      const records = [...productTaxMap.values()]
        .filter((r) => {
          const novoEhReal = !!r.match_rule && isRealCurrentMatchRule(r.match_rule);
          // Exceção manual trava custo/alertas, mas se antes era placeholder sem item,
          // permite enriquecer tributos do XML real sem alterar campos excecao_*.
          if (excecoes.has(r.gc_produto_id) && (!novoEhReal || existingHasRealMatch.has(r.gc_produto_id))) {
            skippedOlder++;
            return false;
          }
          const prev = existingNfDate.get(r.gc_produto_id);
          const novo = r.nf_data_emissao || "";
          // Se já existe match real e o novo é "sem_xml_item", descarta — não regride para placeholder
          if (existingHasRealMatch.has(r.gc_produto_id) && r.match_rule === "pedido_compra_gc_sem_xml_item") {
            skippedOlder++;
            return false;
          }
          // Se o novo é match real e existe NF anterior mais nova, descarta
          if (prev && novoEhReal && novo && novo < prev) {
            skippedOlder++;
            return false;
          }
          return true;
        })
        .map((r) => {
          const rec: Record<string, unknown> = { ...r, ultima_atualizacao: new Date().toISOString() };
          if (manuais.has(r.gc_produto_id)) {
            delete rec.sem_credito;
            delete rec.regime_fornecedor;
          }
          return rec;
        });
      for (let i = 0; i < records.length; i += 50) {
        const batch = records.slice(i, i + 50);
        const { error } = await supabase.from("fin_produto_tributos").upsert(batch as any, { onConflict: "gc_produto_id" });
        if (error) console.error(`upsert tributos batch ${i}:`, error.message);
        else upserted += batch.length;
      }
    }

    // ── Step 7: Insere pendentes ──
    if (!dryRun && pendentesNovos.length > 0) {
      for (let i = 0; i < pendentesNovos.length; i += 100) {
        const batch = pendentesNovos.slice(i, i + 100);
        const { error } = await supabase.from("fin_nfe_match_pendentes").upsert(batch, { onConflict: "compra_gc_id" });
        if (error) console.error(`upsert pendentes batch ${i}:`, error.message);
      }
    }

    // ── Step 8: Insere descartes do picker (diagnóstico) ──
    if (!dryRun && descartesPicker.length > 0) {
      for (let i = 0; i < descartesPicker.length; i += 100) {
        const batch = descartesPicker.slice(i, i + 100);
        const { error } = await supabase.from("fin_nfe_picker_descartes").insert(batch);
        if (error) console.error(`insert descartes batch ${i}:`, error.message);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        total_compras: totalCompras,
        processed: compras.length,
        offset,
        has_more: hasMore,
        next_offset: hasMore ? offset + batchSize : null,
        nivel_1_cnpj_numero: nivel1,
        nivel_2_cnpj_valor: nivel2,
        sem_match: semMatch,
        xmls_lidos: xmlsLidos,
        xmls_falha_bucket: xmlsFalha,
        produtos_atualizados: productTaxMap.size,
        upserted,
        skipped_older: skippedOlder,
        pendentes_registrados: pendentesNovos.length,
        picker_descartes: descartesPicker.length,
        sem_match_amostra: semMatchAmostra.slice(0, 5),
        dry_run: dryRun,
        gc_api_calls: 0,
        reindex_stats: reindexStats,
        tempo_ms: Date.now() - inicio,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[sync-nfe-entrada] erro:", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message, tempo_ms: Date.now() - inicio }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ══════════════════════════════════════════════════════════════
function registrarPendente(
  pendentesNovos: any[],
  amostra: any[],
  compra: CompraRow,
  motivo: string,
  candidatos: any[],
) {
  const row = {
    compra_gc_id: compra.gc_id,
    numero_nfe: compra.numero_nfe,
    cnpj_fornecedor: compra.cnpj_fornecedor,
    nome_fornecedor: compra.nome_fornecedor,
    valor_compra: compra.valor_total,
    data_compra: compra.data,
    motivo,
    candidatos: candidatos.length > 0 ? candidatos : null,
  };
  pendentesNovos.push(row);
  if (amostra.length < 5) {
    amostra.push({
      compra_codigo: compra.codigo,
      compra_gc_id: compra.gc_id,
      numero_nfe: compra.numero_nfe,
      cnpj_fornecedor: compra.cnpj_fornecedor,
      nome_fornecedor: compra.nome_fornecedor,
      valor: compra.valor_total,
      motivo,
      candidatos,
    });
  }
}

// ══════════════════════════════════════════════════════════════
//  Refator v3 — Pedido de Compra GC = fonte única
//  XML serve APENAS para enriquecer tributos.
//  custo_variavel_real NÃO é gravado aqui — vem de v_produto_custo_atual.
// ══════════════════════════════════════════════════════════════
function processarXml(
  xml: string,
  xmlMeta: XmlIndexRow,
  compra: CompraRow,
  matchRuleTag: string,
  productTaxMap: Map<string, ProductTaxRecord>,
  codigoPorProdutoId: Map<string, string>,
  descartesPicker: any[],
) {
  const r = (v: number) => Math.round(v * 100) / 100;
  const xmlItems = parseXmlItems(xml);
  const xmlFrete = getXmlFrete(xml);
  const isSN = isXmlSimplesNacional(xml, xmlItems);
  const totalVProd = xmlItems.reduce((s, i) => s + Math.max(0, i.vProd - (i.vDesc || 0)), 0);
  const meta = getXmlMeta(xml);

  const compraItens = compra.itens;
  const usedXmlIdx = new Set<number>();
  const unresolved: number[] = []; // índices em compraItens que não bateram na 1ª passada


  // Pré-indexa XML por cProd normalizado
  const xmlPorCProd = new Map<string, number[]>();
  for (let i = 0; i < xmlItems.length; i++) {
    const norm = normalizarCodigoProduto(xmlItems[i].cProd);
    if (norm) {
      const arr = xmlPorCProd.get(norm) || [];
      arr.push(i);
      xmlPorCProd.set(norm, arr);
    }
  }

  // Helper: cria registro mínimo sem tributo quando não há XML item correspondente
  const upsertSemTributo = (gcProdId: string, item: CompraItem) => {
    const existing = productTaxMap.get(gcProdId);
    if (existing && existing.nf_data_emissao > (xmlMeta.data_emissao || meta.data_emissao || "")) return;
    productTaxMap.set(gcProdId, {
      gc_produto_id: gcProdId,
      nome_produto: item.nome_produto || "",
      ncm: "",
      cfop: "",
      nf_gc_id: meta.chave || xmlMeta.chave,
      nf_numero: meta.numero_nf || xmlMeta.numero_nf || "",
      nf_chave: xmlMeta.chave,
      nf_data_emissao: xmlMeta.data_emissao || meta.data_emissao || "",
      compra_gc_id: compra.gc_id,
      compra_codigo: compra.codigo,
      fornecedor_nome: xmlMeta.nome_emitente || compra.nome_fornecedor || "",
      regime_fornecedor: isSN ? "simples_nacional" : "normal",
      sem_credito: isSN,
      icms_aliquota: 0, icms_base: 0, pis_aliquota: 0, cofins_aliquota: 0, ipi_aliquota: 0,
      frete_percentual: 0, valor_unitario_nf: 0,
      valor_icms_unit: 0, valor_pis_unit: 0, valor_cofins_unit: 0, valor_ipi_unit: 0, valor_frete_unit: 0,
      custo_efetivo_unit: 0,
      match_rule: "pedido_compra_gc_sem_xml_item",
      descricao_nf: "",
      unidade_comercial_nf: "",
      unidade_tributavel_nf: "",
      q_com: 0, v_un_com: 0, q_trib: 0, v_un_trib: 0, fator_conversao: 1, fator_embalagem: 1,
      v_seg: 0, v_outro: 0, v_desc: 0, v_icms_st: 0, v_fcp_st: 0,
      v_icms_uf_dest: 0, v_icms_uf_remet: 0,
      // custo_variavel_real NÃO é gravado — fonte é gc_produtos_cache.valor_custo via v_produto_custo_atual
      custo_variavel_real: 0,
    });
  };

  for (let pIdx = 0; pIdx < compraItens.length; pIdx++) {
    const item = compraItens[pIdx];
    const gcProdId = item.produto_gc_id;
    if (!gcProdId) continue; // sem produto vinculado no pedido → nada a enriquecer

    let pick: { xi: XmlItemTax; idx: number; rule: string } | null = null;

    // PRIORIDADE 0 (REMOVIDA): antes assumíamos que compra[i] ↔ xml[i] quando
    // ambos tinham o mesmo tamanho. GC e SEFAZ NÃO garantem a mesma ordem —
    // isso produzia vínculos absurdos (ex.: PE BORRACHA amarrado ao CONJUNTO BRACO
    // R$115 só porque caíram na mesma posição). Agora dependemos exclusivamente
    // de cProd (código), nome+valor, ou item único 1×1.

    // PRIORIDADE 1: cProd normalizado == codigo_interno do cadastro
    const codigoCompra = codigoPorProdutoId.get(gcProdId);
    if (!pick && codigoCompra) {
      const candidatos = (xmlPorCProd.get(codigoCompra) || []).filter((idx) => !usedXmlIdx.has(idx));
      if (candidatos.length === 1) {
        pick = { xi: xmlItems[candidatos[0]], idx: candidatos[0], rule: "cprod" };
      } else if (candidatos.length > 1) {
        // múltiplos cProd iguais → desempate por proximidade de VALOR (preço unitário e total)
        // O pedido GC e a NF têm praticamente os mesmos valores; usar isso evita pegar item errado.
        const compraQtd = item.quantidade || 1;
        const compraUnit = item.valor_custo || 0;
        const compraTotal = item.valor_total || (compraUnit * compraQtd);
        let best = candidatos[0];
        let bestScore = Infinity;
        for (const idx of candidatos) {
          const xi = xmlItems[idx];
          const unitDiff = compraUnit > 0 ? Math.abs(xi.vUnCom - compraUnit) / compraUnit : 1;
          const totalDiff = compraTotal > 0 ? Math.abs(xi.vProd - compraTotal) / compraTotal : 1;
          const qtdDiff = compraQtd > 0 ? Math.abs(xi.qCom - compraQtd) / compraQtd : 1;
          // Peso maior em valor (unit e total), qtd como desempate fino
          const score = unitDiff * 0.5 + totalDiff * 0.4 + qtdDiff * 0.1;
          if (score < bestScore) { bestScore = score; best = idx; }
        }
        pick = { xi: xmlItems[best], idx: best, rule: "cprod_multi" };
      }
    }

    // PRIORIDADE 2: nome + aproximação de preço.
    // O pedido GC e o XML da mesma NF têm praticamente os mesmos itens/valores;
    // quando o código interno não bate com o cProd da NF, usar nome + unitário/total evita cair em "s/item".
    if (!pick) {
      const compraNome = normalizeText(item.nome_produto);
      const tokensCompra = compraNome.split(/\s+/).filter((t) => t.length > 1);
      const compraQtd = item.quantidade || 1;
      const compraUnit = item.valor_custo || 0;
      const compraTotal = item.valor_total || (compraUnit * compraQtd);
      let best: { idx: number; score: number } | null = null;

      for (let idx = 0; idx < xmlItems.length; idx++) {
        if (usedXmlIdx.has(idx)) continue;
        const xi = xmlItems[idx];
        const tokensXml = new Set(normalizeText(xi.xProd).split(/\s+/).filter((t) => t.length > 1));
        const comuns = tokensCompra.filter((t) => tokensXml.has(t)).length;
        const tokenScore = comuns / Math.max(1, Math.min(tokensCompra.length, tokensXml.size));
        const unitDiff = compraUnit > 0 ? Math.abs(xi.vUnCom - compraUnit) / compraUnit : 1;
        const totalDiff = compraTotal > 0 ? Math.abs(xi.vProd - compraTotal) / compraTotal : 1;
        const precoCompat = unitDiff <= 0.15 || totalDiff <= 0.05;
        const matchForte = tokenScore >= 0.45 && precoCompat;
        const matchPrecoQuaseExato = tokenScore >= 0.35 && (unitDiff <= 0.03 || totalDiff <= 0.03);
        if (!matchForte && !matchPrecoQuaseExato) continue;

        const score = (1 - tokenScore) * 0.55 + Math.min(unitDiff, 1) * 0.25 + Math.min(totalDiff, 1) * 0.20;
        if (!best || score < best.score) best = { idx, score };
      }

      if (best) pick = { xi: xmlItems[best.idx], idx: best.idx, rule: "nome_preco" };
    }

    // PRIORIDADE 2.5: preço unitário + quantidade praticamente idênticos (tolerância 1%).
    // Pedidos GC + NF costumam usar exatamente o mesmo unitário/qtd — quando o nome diverge
    // completamente (código genérico no cProd, sinônimo comercial no xProd) esta regra evita
    // "perder" o vínculo. Só aplica se o candidato for único ou dominar por larga margem.
    if (!pick) {
      const compraQtd = item.quantidade || 0;
      const compraUnit = item.valor_custo || 0;
      const compraTotal = item.valor_total || (compraUnit * compraQtd);
      const candidatos: Array<{ idx: number; score: number }> = [];
      for (let idx = 0; idx < xmlItems.length; idx++) {
        if (usedXmlIdx.has(idx)) continue;
        const xi = xmlItems[idx];
        const unitDiff = compraUnit > 0 ? Math.abs(xi.vUnCom - compraUnit) / compraUnit : 1;
        const qtdDiff  = compraQtd  > 0 ? Math.abs(xi.qCom  - compraQtd)  / compraQtd  : 1;
        const totalDiff = compraTotal > 0 ? Math.abs(xi.vProd - compraTotal) / compraTotal : 1;
        if ((unitDiff <= 0.01 && qtdDiff <= 0.01) || totalDiff <= 0.005) {
          candidatos.push({ idx, score: unitDiff + qtdDiff + totalDiff });
        }
      }
      candidatos.sort((a, b) => a.score - b.score);
      if (candidatos.length === 1 || (candidatos.length > 1 && candidatos[1].score > candidatos[0].score * 3)) {
        pick = { xi: xmlItems[candidatos[0].idx], idx: candidatos[0].idx, rule: "preco_qtd_exato" };
      }
    }

    // Fallback seguro: NF com 1 item e pedido com 1 item é correspondência inequívoca,
    // mesmo quando o cProd da NF não bate com o código interno do cadastro GC.
    if (!pick && compraItens.length === 1 && xmlItems.length === 1 && !usedXmlIdx.has(0)) {
      pick = { xi: xmlItems[0], idx: 0, rule: "unico" };
    }


    if (!pick) {
      // Adia — depois da 1ª passada, tentamos residual 1×N com os XML items ainda livres
      unresolved.push(pIdx);
      continue;
    }


    enrichAndSet(item, gcProdId, pick);
  }

  // ── Passada residual ──
  // Se ainda há itens do pedido sem match e sobrou apenas 1 XML item livre,
  // faz correspondência 1×1 (a NF/pedido só admite uma leitura possível).
  // Também tenta preço+qtd com tolerância um pouco mais frouxa entre os remanescentes.
  if (unresolved.length > 0) {
    const livres: number[] = [];
    for (let idx = 0; idx < xmlItems.length; idx++) if (!usedXmlIdx.has(idx)) livres.push(idx);

    // 1×1: um item pendente e um XML livre → match determinístico
    if (unresolved.length === 1 && livres.length === 1) {
      const pIdx = unresolved.shift()!;
      const item = compraItens[pIdx];
      if (item.produto_gc_id) {
        enrichAndSet(item, item.produto_gc_id, { xi: xmlItems[livres[0]], idx: livres[0], rule: "residual_1x1" });
      }
    } else if (unresolved.length > 0 && livres.length > 0) {
      // Tentar preço+qtd com tolerância mais frouxa (3%) entre os remanescentes
      const stillUnresolved: number[] = [];
      for (const pIdx of unresolved) {
        const item = compraItens[pIdx];
        if (!item.produto_gc_id) continue;
        const compraQtd = item.quantidade || 0;
        const compraUnit = item.valor_custo || 0;
        const compraTotal = item.valor_total || (compraUnit * compraQtd);
        let best: { idx: number; score: number } | null = null;
        for (const idx of livres) {
          if (usedXmlIdx.has(idx)) continue;
          const xi = xmlItems[idx];
          const unitDiff = compraUnit > 0 ? Math.abs(xi.vUnCom - compraUnit) / compraUnit : 1;
          const totalDiff = compraTotal > 0 ? Math.abs(xi.vProd - compraTotal) / compraTotal : 1;
          if (unitDiff <= 0.03 || totalDiff <= 0.02) {
            const s = unitDiff + totalDiff;
            if (!best || s < best.score) best = { idx, score: s };
          }
        }
        if (best) {
          enrichAndSet(item, item.produto_gc_id, { xi: xmlItems[best.idx], idx: best.idx, rule: "residual_preco" });
        } else {
          stillUnresolved.push(pIdx);
        }
      }
      unresolved.length = 0;
      unresolved.push(...stillUnresolved);
    }
  }

  // ── Não resolvidos → diagnóstico + registro sem tributo ──
  for (const pIdx of unresolved) {
    const item = compraItens[pIdx];
    const gcProdId = item.produto_gc_id;
    if (!gcProdId) continue;
    try {
      const compraNome = normalizeText(item.nome_produto);
      const tokensCompra = compraNome.split(/\s+/).filter((t) => t.length > 1);
      const compraQtd = item.quantidade || 1;
      const compraUnit = item.valor_custo || 0;
      const compraTotal = item.valor_total || (compraUnit * compraQtd);
      const ranking = xmlItems.map((xi, idx) => {
        const tokensXml = new Set(normalizeText(xi.xProd).split(/\s+/).filter((t) => t.length > 1));
        const comuns = tokensCompra.filter((t) => tokensXml.has(t)).length;
        const tokenScore = comuns / Math.max(1, Math.min(tokensCompra.length, tokensXml.size));
        const unitDiff = compraUnit > 0 ? Math.abs(xi.vUnCom - compraUnit) / compraUnit : 1;
        const totalDiff = compraTotal > 0 ? Math.abs(xi.vProd - compraTotal) / compraTotal : 1;
        return {
          idx, nome_nf: xi.xProd, cprod_nf: xi.cProd,
          vunit_nf: Math.round(xi.vUnCom * 100) / 100,
          vtotal_nf: Math.round(xi.vProd * 100) / 100,
          qcom_nf: xi.qCom,
          token_score: Math.round(tokenScore * 1000) / 1000,
          unit_diff_pct: Math.round(unitDiff * 1000) / 10,
          total_diff_pct: Math.round(totalDiff * 1000) / 10,
          usado_por_outro: usedXmlIdx.has(idx),
        };
      });
      ranking.sort((a, b) => b.token_score - a.token_score || a.unit_diff_pct - b.unit_diff_pct);
      const motivoDesc = xmlItems.length === 0
        ? "xml_sem_itens"
        : xmlItems.length === 1 && compraItens.length > 1
          ? "xml_1_item_mas_pedido_multi"
          : ranking[0] && ranking[0].token_score < 0.35 ? "nome_muito_diferente"
          : ranking[0] && ranking[0].token_score < 0.45 ? "score_abaixo_do_threshold"
          : "preco_incompativel";
      descartesPicker.push({
        compra_gc_id: compra.gc_id, compra_codigo: compra.codigo,
        produto_gc_id: gcProdId, nome_produto_pedido: item.nome_produto,
        codigo_interno_pedido: codigoPorProdutoId.get(gcProdId) || null,
        quantidade_pedido: compraQtd, valor_unit_pedido: compraUnit, valor_total_pedido: compraTotal,
        nf_chave: xmlMeta.chave, nf_numero: xmlMeta.numero_nf,
        motivo: motivoDesc, candidatos: ranking.slice(0, 3),
      });
    } catch (_e) { /* diagnóstico não deve quebrar o sync */ }
    upsertSemTributo(gcProdId, item);
  }

  // ── enrichAndSet: aplica um pick (XML item) ao produto do pedido, gravando tributos ──
  function enrichAndSet(item: CompraItem, gcProdId: string, pick: { xi: XmlItemTax; idx: number; rule: string }) {
    usedXmlIdx.add(pick.idx);
    const xi = pick.xi;
    const qComRaw = xi.qCom || 1;
    const compraQtd = item.quantidade || 0;

    let fatorEmbalagem = 1;
    let qtd = qComRaw;
    let packRuleTag = "";
    if (compraQtd > 0 && qComRaw > 0) {
      const totalNF = Math.max(0, xi.vProd - (xi.vDesc || 0));
      const totalPedido = item.valor_total || (item.valor_custo * compraQtd);
      const ratio = compraQtd / qComRaw;
      const totaisBatem = totalPedido > 0 &&
        Math.abs(totalNF - totalPedido) / Math.max(totalNF, totalPedido) <= 0.05;
      const qtdsDiferentes = Math.abs(ratio - 1) > 0.05;
      if (totaisBatem && qtdsDiferentes) {
        fatorEmbalagem = Math.round(ratio * 10000) / 10000;
        qtd = compraQtd;
        packRuleTag = `+pack:${fatorEmbalagem}x`;
      }
    }

    const vProdLiquido = Math.max(0, xi.vProd - (xi.vDesc || 0));
    const valorUnit = vProdLiquido / qtd;
    const proporcao = totalVProd > 0 ? vProdLiquido / totalVProd : 0;
    const freteUnit = qtd > 0 ? (xmlFrete * proporcao) / qtd : 0;
    const ipiUnit = qtd > 0 ? xi.ipi_vIPI / qtd : 0;
    const icmsUnit = isSN ? 0 : qtd > 0 ? xi.icms_vICMS / qtd : 0;
    const pisUnit = isSN ? 0 : qtd > 0 ? xi.pis_vPIS / qtd : 0;
    const cofinsUnit = isSN ? 0 : qtd > 0 ? xi.cofins_vCOFINS / qtd : 0;

    const icmsAliqReal = xi.icms_pICMS || (xi.vProd > 0 ? (xi.icms_vICMS / xi.vProd) * 100 : 0);
    const pisAliqReal = xi.pis_pPIS || (xi.vProd > 0 ? (xi.pis_vPIS / xi.vProd) * 100 : 0);
    const cofinsAliqReal = xi.cofins_pCOFINS || (xi.vProd > 0 ? (xi.cofins_vCOFINS / xi.vProd) * 100 : 0);
    const ipiAliqReal = xi.ipi_pIPI || (xi.vProd > 0 ? (xi.ipi_vIPI / xi.vProd) * 100 : 0);
    const freteRate = totalVProd > 0 ? (xmlFrete / totalVProd) * 100 : 0;
    const icmsBasePerc = xi.vProd > 0 ? (xi.icms_vBC / xi.vProd) * 100 : 100;
    const custoEfetivo = valorUnit + ipiUnit + freteUnit - icmsUnit - pisUnit - cofinsUnit;

    const qComEst = xi.qCom || 0;
    const qTribEst = xi.qTrib || 0;
    const fatorConversao = (qComEst > 0 && qTribEst > 0) ? (qTribEst / qComEst) : 1;

    const existing = productTaxMap.get(gcProdId);
    if (existing && existing.nf_data_emissao > (xmlMeta.data_emissao || meta.data_emissao || "")) return;

    productTaxMap.set(gcProdId, {
      gc_produto_id: gcProdId,
      nome_produto: item.nome_produto || "",
      ncm: xi.NCM || "",
      cfop: xi.CFOP || "",
      nf_gc_id: meta.chave || xmlMeta.chave,
      nf_numero: meta.numero_nf || xmlMeta.numero_nf || "",
      nf_chave: xmlMeta.chave,
      nf_data_emissao: xmlMeta.data_emissao || meta.data_emissao || "",
      compra_gc_id: compra.gc_id,
      compra_codigo: compra.codigo,
      fornecedor_nome: xmlMeta.nome_emitente || compra.nome_fornecedor || "",
      regime_fornecedor: isSN ? "simples_nacional" : "normal",
      sem_credito: isSN,
      icms_aliquota: isSN ? 0 : r(icmsAliqReal),
      icms_base: isSN ? 0 : r(icmsBasePerc),
      pis_aliquota: isSN ? 0 : r(pisAliqReal),
      cofins_aliquota: isSN ? 0 : r(cofinsAliqReal),
      ipi_aliquota: r(ipiAliqReal),
      frete_percentual: r(freteRate),
      valor_unitario_nf: r(valorUnit),
      valor_icms_unit: r(icmsUnit),
      valor_pis_unit: r(pisUnit),
      valor_cofins_unit: r(cofinsUnit),
      valor_ipi_unit: r(ipiUnit),
      valor_frete_unit: r(freteUnit),
      custo_efetivo_unit: r(custoEfetivo),
      match_rule: `pedido_compra_gc+${pick.rule}${packRuleTag}`,
      descricao_nf: xi.xProd || "",
      unidade_comercial_nf: xi.uCom || "",
      unidade_tributavel_nf: xi.uTrib || "",
      q_com: r(qComEst),
      v_un_com: r(xi.vUnCom),
      q_trib: r(qTribEst),
      v_un_trib: r(xi.vUnTrib),
      fator_conversao: Math.round(fatorConversao * 10000) / 10000,
      fator_embalagem: fatorEmbalagem,
      v_seg: r(xi.vSeg),
      v_outro: r(xi.vOutro),
      v_desc: r(xi.vDesc),
      v_icms_st: r(xi.icms_vICMSST),
      v_fcp_st: r(xi.icms_vFCPST),
      v_icms_uf_dest: r(xi.icms_vICMSUFDest),
      v_icms_uf_remet: r(xi.icms_vICMSUFRemet),
      custo_variavel_real: 0,
    });
  }
}


