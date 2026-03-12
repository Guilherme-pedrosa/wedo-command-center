import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── Types ──

interface CompraProduct {
  produto_id: string;
  nome_produto: string;
  quantidade: string;
  valor_custo: string;
  valor_total: string;
  unidade: string;
}

interface NFProduct {
  produto_id: string;
  codigo_produto: string;
  nome_produto: string;
  cfop: string;
  NCM: string;
  unidade: string;
  quantidade: string;
  valor_venda: string;
}

interface NFData {
  id: string;
  compra_id: string;
  tipo_nf: string;
  numero_nf: string;
  chave: string;
  data_emissao: string;
  situacao_nf: string;
  cnpj_emitente: string;
  nome_emitente: string;
  fantasia_emitente: string;
  valor_total_nf: string;
  valor_produtos: string;
  base_icms: string;
  valor_icms: string;
  valor_pis: string;
  valor_cofins: string;
  valor_ipi: string;
  valor_frete: string;
  valor_fcp: string;
  valor_icms_st: string;
  valor_seguro: string;
  valor_desconto: string;
  valor_outros: string;
  produtos: NFProduct[];
}

interface ProductTaxRecord {
  gc_produto_id: string;
  nome_produto: string;
  ncm: string;
  cfop: string;
  nf_gc_id: string;
  nf_numero: string | null;
  nf_chave: string;
  nf_data_emissao: string | null;
  compra_gc_id: string;
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
}

// ══════════════════════════════════════════════════════════════
//  XML PARSER — extrai impostos POR ITEM do XML real da NF-e
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
  return [...xml.matchAll(re)].map(m => m[0]);
}

interface XmlItemTax {
  nItem: number;
  cProd: string;
  xProd: string;
  NCM: string;
  CFOP: string;
  qCom: number;
  vProd: number;
  vUnCom: number;
  icms_orig: string;
  icms_cst: string;
  icms_pRedBC: number;
  icms_vBC: number;
  icms_pICMS: number;
  icms_vICMS: number;
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
    const xProd = getTag(prod, "xProd");
    const NCM = getTag(prod, "NCM");
    const CFOP = getTag(prod, "CFOP");
    const qCom = parseFloat(getTag(prod, "qCom")) || 1;
    const vProd = parseFloat(getTag(prod, "vProd")) || 0;
    const vUnCom = parseFloat(getTag(prod, "vUnCom")) || 0;
    const icmsBlock = getBlock(imposto, "ICMS");
    const icmsInner = icmsBlock.replace(/<\/?(?:[a-zA-Z0-9]+:)?ICMS>/gi, "").trim();
    const icms_orig = getTag(icmsInner, "orig");
    const icms_cst = getTag(icmsInner, "CST") || getTag(icmsInner, "CSOSN");
    const icms_pRedBC = parseFloat(getTag(icmsInner, "pRedBC")) || 0;
    const icms_vBC = parseFloat(getTag(icmsInner, "vBC")) || 0;
    const icms_pICMS = parseFloat(getTag(icmsInner, "pICMS")) || 0;
    const icms_vICMS = parseFloat(getTag(icmsInner, "vICMS")) || 0;
    const ipiBlock = getBlock(imposto, "IPI");
    const ipiTrib = getBlock(ipiBlock, "IPITrib") || ipiBlock;
    const ipi_cst = getTag(ipiTrib, "CST") || getTag(getBlock(ipiBlock, "IPINT"), "CST") || "";
    const ipi_vBC = parseFloat(getTag(ipiTrib, "vBC")) || 0;
    const ipi_pIPI = parseFloat(getTag(ipiTrib, "pIPI")) || 0;
    const ipi_vIPI = parseFloat(getTag(ipiTrib, "vIPI")) || 0;
    const pisBlock = getBlock(imposto, "PIS");
    const pisInner = getBlock(pisBlock, "PISAliq") || getBlock(pisBlock, "PISQtde") || getBlock(pisBlock, "PISOutr") || pisBlock;
    const pis_cst = getTag(pisInner, "CST") || getTag(getBlock(pisBlock, "PISNT"), "CST") || "";
    const pis_vBC = parseFloat(getTag(pisInner, "vBC")) || 0;
    const pis_pPIS = parseFloat(getTag(pisInner, "pPIS")) || 0;
    const pis_vPIS = parseFloat(getTag(pisInner, "vPIS")) || 0;
    const cofinsBlock = getBlock(imposto, "COFINS");
    const cofinsInner = getBlock(cofinsBlock, "COFINSAliq") || getBlock(cofinsBlock, "COFINSQtde") || getBlock(cofinsBlock, "COFINSOutr") || cofinsBlock;
    const cofins_cst = getTag(cofinsInner, "CST") || getTag(getBlock(cofinsBlock, "COFINSNT"), "CST") || "";
    const cofins_vBC = parseFloat(getTag(cofinsInner, "vBC")) || 0;
    const cofins_pCOFINS = parseFloat(getTag(cofinsInner, "pCOFINS")) || 0;
    const cofins_vCOFINS = parseFloat(getTag(cofinsInner, "vCOFINS")) || 0;
    items.push({
      nItem, cProd, xProd, NCM, CFOP, qCom, vProd, vUnCom,
      icms_orig, icms_cst, icms_pRedBC, icms_vBC, icms_pICMS, icms_vICMS,
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

function isXmlSimplesNacional(xml: string, xmlItems?: XmlItemTax[]): boolean {
  const emit = getBlock(xml, "emit");
  const crt = getTag(emit, "CRT");
  const crtIsSN = crt === "1" || crt === "2";
  const hasCSOSN = xmlItems?.some(item => item.icms_cst && /^\d{3}$/.test(item.icms_cst) &&
    ["101","102","103","201","202","203","300","400","500","900"].includes(item.icms_cst));
  const isSNByTag = crtIsSN || !!hasCSOSN;
  if (!isSNByTag && crt) return false;
  if (xmlItems && xmlItems.length > 0) {
    const hasRealTaxes = xmlItems.some(item =>
      item.icms_vICMS > 0 || item.pis_vPIS > 0 || item.cofins_vCOFINS > 0
    );
    if (hasRealTaxes) {
      console.log(`[offline] CRT=${crt} CSOSN=${hasCSOSN} mas impostos reais — NÃO é SN`);
      return false;
    }
  }
  return isSNByTag;
}

function normalizeText(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || text.toLowerCase() === "null" || text.toLowerCase() === "undefined") return "";
  return text;
}

// ══════════════════════════════════════════════════════════════

async function tryDownloadXml(chave: string, supabase: any): Promise<string | null> {
  if (!chave || chave.length < 44) return null;
  const paths = [`${chave}.xml`, `NF-e${chave}.xml`, `NFe${chave}.xml`, `nfe-${chave}.xml`];
  for (const path of paths) {
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
//  SERVE — Modo Offline: lê gc_compras do BD + XMLs do bucket
// ══════════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const offset = Number(body.offset) || 0;
    const batchSize = Math.min(Number(body.batch_size) || 80, 200);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ── Step 1: Count total compras with payload AND NF-e linked ──
    // Only process purchases that have a linked NF-e AND are in approved statuses
    // Filter: only compras from Jan 2025 onwards
    const ALLOWED_SITUACAO_IDS = ["1675070", "2072508", "2072509", "2072571"];
    const DATA_INICIO = "2025-01-01";
    
    const { count: totalCompras } = await supabase
      .from("gc_compras")
      .select("*", { count: "exact", head: true })
      .not("gc_payload_raw", "is", null)
      .neq("gc_payload_raw->Compra->>numero_nfe", "")
      .in("situacao_id", ALLOWED_SITUACAO_IDS)
      .gte("data", DATA_INICIO);

    const total = totalCompras || 0;
    console.log(`[offline] Total compras COM NF-e, situação válida e data >= ${DATA_INICIO}: ${total}, offset=${offset}, batch=${batchSize}`);

    // ── Step 2: Fetch batch of compras from BD (only with NF-e + valid status + date filter) ──
    const { data: comprasDb, error: compraErr } = await supabase
      .from("gc_compras")
      .select("gc_id, nome_fornecedor, fornecedor_id, valor_total, valor_produtos, valor_frete, gc_payload_raw")
      .not("gc_payload_raw", "is", null)
      .neq("gc_payload_raw->Compra->>numero_nfe", "")
      .in("situacao_id", ALLOWED_SITUACAO_IDS)
      .gte("data", DATA_INICIO)
      .order("gc_id")
      .range(offset, offset + batchSize - 1);

    if (compraErr) throw compraErr;
    const compras = comprasDb || [];

    if (compras.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, total_compras: total, processed: 0, has_more: false, next_offset: 0, produtos_processados: 0, upserted: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const hasMore = offset + batchSize < total;
    const nextOffset = offset + batchSize;

    // ── Step 2.5: On first batch, clear stale tributos (preserve manual overrides) ──
    if (offset === 0) {
      console.log("[offline] Limpando dados antigos de tributos...");
      await supabase
        .from("fin_produto_tributos")
        .delete()
        .is("icms_aliquota_manual", null)
        .is("pis_aliquota_manual", null)
        .is("cofins_aliquota_manual", null)
        .is("ipi_aliquota_manual", null)
        .eq("sem_credito", false);
    }

    // ── Step 3: Build CNPJ → XMLs index ──
    const { data: xmlIndex } = await supabase
      .from("fin_nfe_xml_index")
      .select("chave, cnpj_emitente, nome_emitente, data_emissao, valor_total, valor_produtos, qtd_itens, storage_path");

    const cnpjToXmls = new Map<string, typeof xmlIndex>();
    for (const xi of (xmlIndex || [])) {
      if (!xi.cnpj_emitente) continue;
      const list = cnpjToXmls.get(xi.cnpj_emitente) || [];
      list.push(xi);
      cnpjToXmls.set(xi.cnpj_emitente, list);
    }

    // ── Step 4: Build fornecedor CNPJ map ──
    const fornecedorIds = [...new Set(compras.map(c => String(c.fornecedor_id || "")).filter(Boolean))];
    const fornecedorIdToCnpj = new Map<string, string>();
    for (let i = 0; i < fornecedorIds.length; i += 100) {
      const chunk = fornecedorIds.slice(i, i + 100);
      const { data: forns } = await supabase.from("fin_fornecedores").select("gc_id, cpf_cnpj").in("gc_id", chunk);
      for (const f of (forns || [])) {
        if (f.cpf_cnpj) {
          const cnpj = f.cpf_cnpj.replace(/\D/g, "");
          if (cnpj.length >= 11) fornecedorIdToCnpj.set(f.gc_id, cnpj);
        }
      }
    }

    // ── Step 5: Process each compra ──
    const productTaxMap = new Map<string, ProductTaxRecord>();
    let xmlsUsed = 0;
    let comprasProcessed = 0;

    for (const compraDb of compras) {
      const payload = (compraDb.gc_payload_raw as any)?.Compra ?? compraDb.gc_payload_raw;
      if (!payload) continue;

      const compraId = String(compraDb.gc_id);
      const fornecedorNome = normalizeText(compraDb.nome_fornecedor) || normalizeText(payload.nome_fornecedor);
      const fornecedorId = String(compraDb.fornecedor_id || payload.fornecedor_id || "");
      const fornecedorCnpj = fornecedorIdToCnpj.get(fornecedorId);

      // Extract products from payload
      const rawProdutos = payload.produtos || [];
      const compraProdutos: CompraProduct[] = [];
      for (const p of rawProdutos) {
        const prod = p.produto ?? p;
        if (prod?.produto_id) compraProdutos.push(prod);
      }
      if (compraProdutos.length === 0) continue;

      // Try to find XML by fornecedor CNPJ
      let xmlContent: string | null = null;
      let matchedChave = "";

      if (fornecedorCnpj && cnpjToXmls.has(fornecedorCnpj)) {
        const candidateXmls = cnpjToXmls.get(fornecedorCnpj)!;
        const compraValor = parseFloat(String(compraDb.valor_total || payload.valor_total || "0"));
        let bestXml = candidateXmls[0];
        let bestDiff = Infinity;

        for (const candidate of candidateXmls) {
          const diff = Math.abs((candidate.valor_total || 0) - compraValor);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestXml = candidate;
          }
        }

        const tolerance = Math.max(compraValor * 0.1, 5);
        if (bestDiff <= tolerance && bestXml) {
          xmlContent = await tryDownloadXml(bestXml.chave, supabase);
          if (xmlContent) {
            matchedChave = bestXml.chave;
            // Remove from candidates to avoid double-matching
            const idx = candidateXmls.indexOf(bestXml);
            if (idx >= 0) candidateXmls.splice(idx, 1);
          }
        }
      }

      if (!xmlContent) {
        // No XML found for this compra — skip (no point in proportional without XML data)
        continue;
      }

      xmlsUsed++;
      comprasProcessed++;

      // ── Parse XML and match products ──
      const xmlItems = parseXmlItems(xmlContent);
      const xmlFrete = getXmlFrete(xmlContent);
      const isSN = isXmlSimplesNacional(xmlContent, xmlItems);
      const totalVProd = xmlItems.reduce((s, i) => s + i.vProd, 0);
      const usedXmlIndices = new Set<number>();
      const r = (v: number) => Math.round(v * 100) / 100;

      // Extract NF number from chave (positions 25-33) and data_emissao from XML
      const nfNumeroFromChave = matchedChave.length === 44 ? String(parseInt(matchedChave.substring(25, 34))) : null;
      const xmlDataEmissao = getTag(xmlContent, "dhEmi")?.substring(0, 10) || getTag(xmlContent, "dEmi") || null;

      for (const compraProd of compraProdutos) {
        const gcProdId = String(compraProd.produto_id);
        const compraProdValor = parseFloat(compraProd.valor_total || "0") || 0;
        const compraProdQtd = parseFloat(compraProd.quantidade || "1") || 1;
        const compraProdUnitario = compraProdQtd > 0 ? compraProdValor / compraProdQtd : compraProdValor;
        const compraProdNome = normalizeText(compraProd.nome_produto || "");

        let xmlItem: XmlItemTax | undefined;
        let bestIdx = -1;

        // ── PRIORIDADE 1: Match por código do produto (cProd === produto_id) ──
        for (let i = 0; i < xmlItems.length; i++) {
          if (usedXmlIndices.has(i)) continue;
          if (xmlItems[i].cProd === gcProdId) {
            xmlItem = xmlItems[i];
            bestIdx = i;
            break;
          }
        }

        // ── PRIORIDADE 2: Match por nome (similaridade de tokens) ──
        if (!xmlItem) {
          const tokensCompra = compraProdNome.split(/\s+/).filter(t => t.length > 2);
          let bestNameScore = 0;
          let bestNameDiff = Infinity;

          for (let i = 0; i < xmlItems.length; i++) {
            if (usedXmlIndices.has(i)) continue;
            const xmlNome = normalizeText(xmlItems[i].xProd);
            const tokensXml = new Set(xmlNome.split(/\s+/).filter(t => t.length > 2));
            const comuns = tokensCompra.filter(t => tokensXml.has(t)).length;
            const base = Math.max(1, Math.min(tokensCompra.length, tokensXml.size));
            const score = comuns / base;

            if (score >= 0.5 && (score > bestNameScore || (score === bestNameScore && Math.abs(xmlItems[i].vProd - compraProdValor) < bestNameDiff))) {
              bestNameScore = score;
              bestNameDiff = Math.abs(xmlItems[i].vProd - compraProdValor);
              xmlItem = xmlItems[i];
              bestIdx = i;
            }
          }
        }

        // ── PRIORIDADE 3: Match por valor total ou unitário (tolerância 5%) ──
        if (!xmlItem) {
          const matchTolerance = Math.max(compraProdValor * 0.05, 0.50);
          const unitTolerance = Math.max(compraProdUnitario * 0.05, 0.10);
          let bestDiff = Infinity;

          for (let i = 0; i < xmlItems.length; i++) {
            if (usedXmlIndices.has(i)) continue;
            const xi = xmlItems[i];
            const diffTotal = Math.abs(xi.vProd - compraProdValor);
            if (diffTotal <= matchTolerance && diffTotal < bestDiff) {
              bestDiff = diffTotal;
              bestIdx = i;
              xmlItem = xi;
            }
            if (!xmlItem || diffTotal > matchTolerance) {
              const diffUnit = Math.abs(xi.vUnCom - compraProdUnitario);
              const sameQtd = Math.abs(xi.qCom - compraProdQtd) < 0.01;
              if (sameQtd && diffUnit <= unitTolerance && diffUnit < bestDiff) {
                bestDiff = diffUnit;
                bestIdx = i;
                xmlItem = xi;
              }
            }
          }
        }

        // ── PRIORIDADE 4: Produto único na compra + item único no XML ──
        if (!xmlItem && compraProdutos.length === 1 && xmlItems.length === 1 && usedXmlIndices.size === 0) {
          xmlItem = xmlItems[0];
          bestIdx = 0;
        }

        if (xmlItem && bestIdx >= 0) {
          usedXmlIndices.add(bestIdx);

          const qtd = xmlItem.qCom || 1;
          const valorUnit = xmlItem.vProd / qtd;
          const proporcao = totalVProd > 0 ? xmlItem.vProd / totalVProd : 0;
          const freteUnit = qtd > 0 ? (xmlFrete * proporcao) / qtd : 0;
          const ipiUnit = qtd > 0 ? xmlItem.ipi_vIPI / qtd : 0;
          const icmsUnit = isSN ? 0 : (qtd > 0 ? xmlItem.icms_vICMS / qtd : 0);
          const pisUnit = isSN ? 0 : (qtd > 0 ? xmlItem.pis_vPIS / qtd : 0);
          const cofinsUnit = isSN ? 0 : (qtd > 0 ? xmlItem.cofins_vCOFINS / qtd : 0);

          // Fix #5: pICMS direto do XML
          const icmsAliqReal = xmlItem.icms_pICMS || (xmlItem.vProd > 0 ? (xmlItem.icms_vICMS / xmlItem.vProd) * 100 : 0);
          const pisAliqReal = xmlItem.pis_pPIS || (xmlItem.vProd > 0 ? (xmlItem.pis_vPIS / xmlItem.vProd) * 100 : 0);
          const cofinsAliqReal = xmlItem.cofins_pCOFINS || (xmlItem.vProd > 0 ? (xmlItem.cofins_vCOFINS / xmlItem.vProd) * 100 : 0);
          const ipiAliqReal = xmlItem.ipi_pIPI || (xmlItem.vProd > 0 ? (xmlItem.ipi_vIPI / xmlItem.vProd) * 100 : 0);
          const freteRate = totalVProd > 0 ? (xmlFrete / totalVProd) * 100 : 0;
          const icmsBasePerc = xmlItem.vProd > 0 ? (xmlItem.icms_vBC / xmlItem.vProd) * 100 : 100;
          const custoEfetivo = valorUnit + ipiUnit + freteUnit - icmsUnit - pisUnit - cofinsUnit;

          const existing = productTaxMap.get(gcProdId);
          if (existing) continue; // Keep first match

          productTaxMap.set(gcProdId, {
            gc_produto_id: gcProdId,
            nome_produto: xmlItem.xProd || compraProd.nome_produto || "",
            ncm: xmlItem.NCM || "",
            cfop: xmlItem.CFOP || "",
            nf_gc_id: matchedChave,
            nf_numero: nfNumeroFromChave,
            nf_chave: matchedChave,
            nf_data_emissao: xmlDataEmissao,
            compra_gc_id: compraId,
            fornecedor_nome: fornecedorNome || "",
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
          });

          console.log(`[offline] ✓ ${gcProdId} "${xmlItem.xProd}" ICMS=${r(icmsAliqReal)}% PIS=${r(pisAliqReal)}% COFINS=${r(cofinsAliqReal)}%`);
        } else {
          // Fallback: rateio proporcional pelos totais do XML
          // Use actual values first, but fallback to weighted average of aliquotas if values are zero
          const totalICMS = xmlItems.reduce((s, i) => s + i.icms_vICMS, 0);
          const totalPIS = xmlItems.reduce((s, i) => s + i.pis_vPIS, 0);
          const totalCOFINS = xmlItems.reduce((s, i) => s + i.cofins_vCOFINS, 0);
          const totalIPI = xmlItems.reduce((s, i) => s + i.ipi_vIPI, 0);
          const totalBaseICMS = xmlItems.reduce((s, i) => s + i.icms_vBC, 0);

          // If PIS/COFINS values are zero but aliquotas exist, use weighted average of aliquotas
          const avgPisAliqFromRate = xmlItems.length > 0
            ? xmlItems.reduce((s, i) => s + i.pis_pPIS * i.vProd, 0) / (totalVProd || 1) : 0;
          const avgCofinsAliqFromRate = xmlItems.length > 0
            ? xmlItems.reduce((s, i) => s + i.cofins_pCOFINS * i.vProd, 0) / (totalVProd || 1) : 0;

          const avgIcmsAliq = totalVProd > 0 ? (totalICMS / totalVProd) * 100 : 0;
          const avgPisAliq = totalPIS > 0 ? (totalPIS / totalVProd) * 100 : avgPisAliqFromRate;
          const avgCofinsAliq = totalCOFINS > 0 ? (totalCOFINS / totalVProd) * 100 : avgCofinsAliqFromRate;
          const avgIpiAliq = totalVProd > 0 ? (totalIPI / totalVProd) * 100 : 0;
          const freteRate = totalVProd > 0 ? (xmlFrete / totalVProd) * 100 : 0;
          const icmsBasePerc = totalVProd > 0 ? (totalBaseICMS / totalVProd) * 100 : 100;

          const qtd = parseFloat(compraProd.quantidade || "1") || 1;
          const valorUnit = compraProdQtd > 0 ? compraProdValor / compraProdQtd : compraProdValor;
          const icmsUnit = isSN ? 0 : valorUnit * (avgIcmsAliq / 100);
          const pisUnit = isSN ? 0 : valorUnit * (avgPisAliq / 100);
          const cofinsUnit = isSN ? 0 : valorUnit * (avgCofinsAliq / 100);
          const ipiUnit = valorUnit * (avgIpiAliq / 100);
          const freteUnit = valorUnit * (freteRate / 100);
          const custoEfetivo = valorUnit + ipiUnit + freteUnit - icmsUnit - pisUnit - cofinsUnit;

          const existing = productTaxMap.get(gcProdId);
          if (existing) continue;

          productTaxMap.set(gcProdId, {
            gc_produto_id: gcProdId,
            nome_produto: compraProd.nome_produto || "",
            ncm: xmlItems[0]?.NCM || "",
            cfop: xmlItems[0]?.CFOP || "",
            nf_gc_id: matchedChave,
            nf_numero: nfNumeroFromChave,
            nf_chave: matchedChave,
            nf_data_emissao: xmlDataEmissao,
            compra_gc_id: compraId,
            fornecedor_nome: fornecedorNome || "",
            regime_fornecedor: isSN ? "simples_nacional" : "normal",
            sem_credito: isSN,
            icms_aliquota: isSN ? 0 : r(avgIcmsAliq),
            icms_base: isSN ? 0 : r(icmsBasePerc),
            pis_aliquota: isSN ? 0 : r(avgPisAliq),
            cofins_aliquota: isSN ? 0 : r(avgCofinsAliq),
            ipi_aliquota: r(avgIpiAliq),
            frete_percentual: r(freteRate),
            valor_unitario_nf: r(valorUnit),
            valor_icms_unit: r(icmsUnit),
            valor_pis_unit: r(pisUnit),
            valor_cofins_unit: r(cofinsUnit),
            valor_ipi_unit: r(ipiUnit),
            valor_frete_unit: r(freteUnit),
            custo_efetivo_unit: r(custoEfetivo),
          });

          console.log(`[offline] rateio ✓ ${gcProdId} "${compraProd.nome_produto}" ICMS=${r(avgIcmsAliq)}% PIS=${r(avgPisAliq)}% COFINS=${r(avgCofinsAliq)}%`);
        }
      }
    }

    // ── Step 6: Upsert, preserving manual overrides ──
    const existingIds = [...productTaxMap.keys()];
    const existingManual = new Set<string>();
    for (let i = 0; i < existingIds.length; i += 100) {
      const batch = existingIds.slice(i, i + 100);
      const { data } = await supabase
        .from("fin_produto_tributos")
        .select("gc_produto_id, icms_aliquota_manual, pis_aliquota_manual, cofins_aliquota_manual, sem_credito")
        .in("gc_produto_id", batch);
      for (const row of (data || [])) {
        if (row.sem_credito || row.icms_aliquota_manual != null || row.pis_aliquota_manual != null || row.cofins_aliquota_manual != null) {
          existingManual.add(row.gc_produto_id);
        }
      }
    }

    const records = [...productTaxMap.values()].map((rec) => {
      const obj: Record<string, unknown> = { ...rec, ultima_atualizacao: new Date().toISOString() };
      if (existingManual.has(rec.gc_produto_id)) {
        delete obj.sem_credito;
        delete obj.regime_fornecedor;
      }
      return obj;
    });

    let upserted = 0;
    for (let i = 0; i < records.length; i += 50) {
      const batch = records.slice(i, i + 50);
      const { error } = await supabase.from("fin_produto_tributos").upsert(batch as any, { onConflict: "gc_produto_id" });
      if (error) {
        console.error(`[offline] Upsert error batch ${i}:`, error.message);
      } else {
        upserted += batch.length;
      }
    }

    if (!hasMore) {
      await supabase.from("fin_sync_log").insert({
        tipo: "sync_nfe_entrada_offline",
        status: "ok",
        payload: { total_compras: total, compras_processadas: comprasProcessed, xmls_usados: xmlsUsed, total_produtos: records.length },
        resposta: { upserted },
      });
    }

    console.log(`[offline] Batch done: ${comprasProcessed} compras, ${xmlsUsed} XMLs, ${records.length} produtos`);

    return new Response(
      JSON.stringify({
        ok: true,
        total_compras: total,
        processed: compras.length,
        offset,
        has_more: hasMore,
        next_offset: hasMore ? nextOffset : null,
        compras_processadas: comprasProcessed,
        xmls_usados: xmlsUsed,
        produtos_processados: records.length,
        upserted,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[offline] Error:", (error as Error).message);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
