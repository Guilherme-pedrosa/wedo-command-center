import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";
const MIN_DELAY_MS = 350;
const DAILY_LIMIT = 2000;
let lastCallTime = 0;
let gcCallCount = 0;

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  }
  lastCallTime = Date.now();
  gcCallCount++;
  return fetch(url, options);
}

// Check daily counter (shared with gc-proxy via fin_configuracoes)
async function checkDailyLimit(supabase: any): Promise<{ allowed: boolean; count: number }> {
  const today = new Date().toISOString().split("T")[0];
  const chave = "gc_api_daily_counter";

  const { data: row } = await supabase
    .from("fin_configuracoes")
    .select("valor, updated_at")
    .eq("chave", chave)
    .maybeSingle();

  let currentCount = 0;
  if (row) {
    const lastDate = row.updated_at ? row.updated_at.split("T")[0] : "";
    if (lastDate === today) {
      currentCount = parseInt(row.valor || "0") || 0;
    }
  }

  return { allowed: currentCount < DAILY_LIMIT, count: currentCount };
}

async function incrementDailyCounter(supabase: any, increment: number) {
  const today = new Date().toISOString().split("T")[0];
  const chave = "gc_api_daily_counter";

  const { data: row } = await supabase
    .from("fin_configuracoes")
    .select("valor, updated_at")
    .eq("chave", chave)
    .maybeSingle();

  let currentCount = 0;
  if (row) {
    const lastDate = row.updated_at ? row.updated_at.split("T")[0] : "";
    if (lastDate === today) {
      currentCount = parseInt(row.valor || "0") || 0;
    }
  }

  await supabase
    .from("fin_configuracoes")
    .upsert(
      { chave, valor: String(currentCount + increment), updated_at: new Date().toISOString(), descricao: "Contador diário de chamadas à API GestãoClick" },
      { onConflict: "chave" }
    );
}

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
  nf_numero: string;
  nf_chave: string;
  nf_data_emissao: string;
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
  // ICMS
  icms_orig: string;
  icms_cst: string;
  icms_pRedBC: number;
  icms_vBC: number;
  icms_pICMS: number;
  icms_vICMS: number;
  // IPI
  ipi_cst: string;
  ipi_vBC: number;
  ipi_pIPI: number;
  ipi_vIPI: number;
  // PIS
  pis_cst: string;
  pis_vBC: number;
  pis_pPIS: number;
  pis_vPIS: number;
  // COFINS
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

    // ── Produto ──
    const cProd = getTag(prod, "cProd");
    const xProd = getTag(prod, "xProd");
    const NCM = getTag(prod, "NCM");
    const CFOP = getTag(prod, "CFOP");
    const qCom = parseFloat(getTag(prod, "qCom")) || 1;
    const vProd = parseFloat(getTag(prod, "vProd")) || 0;
    const vUnCom = parseFloat(getTag(prod, "vUnCom")) || 0;

    // ── ICMS — try all CST variants (ICMS00, ICMS10, ICMS20, ICMS30, ICMS40, ICMS51, ICMS60, ICMS70, ICMS90, ICMSSN101...) ──
    const icmsBlock = getBlock(imposto, "ICMS");
    // Find the actual CST-specific block inside <ICMS>
    const icmsInner = icmsBlock.replace(/<\/?(?:[a-zA-Z0-9]+:)?ICMS>/gi, "").trim();
    const icms_orig = getTag(icmsInner, "orig");
    const icms_cst = getTag(icmsInner, "CST") || getTag(icmsInner, "CSOSN");
    const icms_pRedBC = parseFloat(getTag(icmsInner, "pRedBC")) || 0;
    const icms_vBC = parseFloat(getTag(icmsInner, "vBC")) || 0;
    const icms_pICMS = parseFloat(getTag(icmsInner, "pICMS")) || 0;
    const icms_vICMS = parseFloat(getTag(icmsInner, "vICMS")) || 0;

    // ── IPI ──
    const ipiBlock = getBlock(imposto, "IPI");
    const ipiTrib = getBlock(ipiBlock, "IPITrib") || ipiBlock;
    const ipi_cst = getTag(ipiTrib, "CST") || getTag(getBlock(ipiBlock, "IPINT"), "CST") || "";
    const ipi_vBC = parseFloat(getTag(ipiTrib, "vBC")) || 0;
    const ipi_pIPI = parseFloat(getTag(ipiTrib, "pIPI")) || 0;
    const ipi_vIPI = parseFloat(getTag(ipiTrib, "vIPI")) || 0;

    // ── PIS ──
    const pisBlock = getBlock(imposto, "PIS");
    const pisInner = getBlock(pisBlock, "PISAliq") || getBlock(pisBlock, "PISQtde") || getBlock(pisBlock, "PISOutr") || pisBlock;
    const pis_cst = getTag(pisInner, "CST") || getTag(getBlock(pisBlock, "PISNT"), "CST") || "";
    const pis_vBC = parseFloat(getTag(pisInner, "vBC")) || 0;
    const pis_pPIS = parseFloat(getTag(pisInner, "pPIS")) || 0;
    const pis_vPIS = parseFloat(getTag(pisInner, "vPIS")) || 0;

    // ── COFINS ──
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

// Detect Simples Nacional from XML: CRT=1 or CRT=2 in <emit>
// BUT override if the XML items actually carry ICMS/PIS/COFINS values
// (some emitters set CRT=1 erroneously or use CSOSN with real tax values)
function isXmlSimplesNacional(xml: string, xmlItems?: XmlItemTax[]): boolean {
  const emit = getBlock(xml, "emit");
  const crt = getTag(emit, "CRT");
  const crtIsSN = crt === "1" || crt === "2";
  
  // Fix #4: Also detect SN by presence of CSOSN tag in any item
  // If any item has <CSOSN> instead of <CST> inside ICMS, it's SN
  const hasCSOSN = xmlItems?.some(item => item.icms_cst && /^\d{3}$/.test(item.icms_cst) && 
    ["101","102","103","201","202","203","300","400","500","900"].includes(item.icms_cst));
  
  const isSNByTag = crtIsSN || !!hasCSOSN;
  
  // If CRT says normal (3) AND no CSOSN found, it's definitely not SN
  if (!isSNByTag && crt) return false;
  
  // If we have parsed items, check if any item actually has tax values
  // If they do, the emitter is NOT operating under SN for this NF
  if (xmlItems && xmlItems.length > 0) {
    const hasRealTaxes = xmlItems.some(item => 
      item.icms_vICMS > 0 || item.pis_vPIS > 0 || item.cofins_vCOFINS > 0
    );
    if (hasRealTaxes) {
      console.log(`[sync-nfe-entrada] CRT=${crt} CSOSN=${hasCSOSN} mas itens têm impostos reais — NÃO é Simples Nacional`);
      return false;
    }
  }
  
  return isSNByTag;
}

// ══════════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const offset = Number(body.offset) || 0;
    const batchSize = Math.min(Number(body.batch_size) || 80, 120);

    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");
    if (!gcAccessToken || !gcSecretToken) {
      return new Response(JSON.stringify({ error: "GC credentials not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const gcHeaders: Record<string, string> = {
      "access-token": gcAccessToken,
      "secret-access-token": gcSecretToken,
      "Content-Type": "application/json",
    };

    // ── Check daily API limit before proceeding ──
    gcCallCount = 0; // reset counter for this invocation
    const { allowed, count: dailyCount } = await checkDailyLimit(supabase);
    if (!allowed) {
      console.warn(`[sync-nfe-entrada] LIMITE DIÁRIO ATINGIDO: ${dailyCount}/${DAILY_LIMIT}`);
      return new Response(
        JSON.stringify({ error: `Limite diário de ${DAILY_LIMIT} chamadas à API atingido (${dailyCount} usadas). Tente amanhã.`, code: "DAILY_LIMIT_EXCEEDED" }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Step 1: Find situação IDs for finalized purchases ──
    console.log("[sync-nfe-entrada] Fetching situacoes_compras...");
    const sitResp = await rateLimitedFetch(`${GC_BASE_URL}/api/situacoes_compras`, { headers: gcHeaders });
    const situacaoIds: string[] = [];
    if (sitResp.ok) {
      const sitData = await sitResp.json();
      for (const sit of (sitData?.data || [])) {
        const nome = String(sit.nome || "").toLowerCase().trim();
        if (
          (nome.includes("finalizado") && nome.includes("mercadoria chegou")) ||
          (nome.includes("comprado") && nome.includes("ag chegada"))
        ) {
          situacaoIds.push(String(sit.id));
          console.log(`[sync-nfe-entrada] Situacao: ${sit.nome} (id=${sit.id})`);
        }
      }
    }
    if (situacaoIds.length === 0) {
      return new Response(JSON.stringify({ error: "No matching situacao_ids found for compras" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Step 2: Fetch ALL compra IDs (paginated) ──
    interface CompraRaw {
      id: string;
      codigo: string;
      fornecedor_id: string;
      nome_fornecedor: string;
      data_emissao: string;
      numero_nfe: string | null;
      valor_produtos: string;
      valor_frete: string;
      valor_total: string;
      produtos: Array<{ produto?: CompraProduct } | CompraProduct>;
    }

    const allCompras: CompraRaw[] = [];
    for (const sitId of situacaoIds) {
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages) {
        const url = `${GC_BASE_URL}/api/compras?limite=100&pagina=${page}&situacao_id=${sitId}`;
        const resp = await rateLimitedFetch(url, { headers: gcHeaders });
        if (resp.status === 429) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (!resp.ok) {
          console.error(`[sync-nfe-entrada] Compras error: ${resp.status}`);
          break;
        }
        const json = await resp.json();
        const items = json.data || [];
        totalPages = json.meta?.total_paginas || 1;

        for (const raw of items) {
          const c = (raw as any).Compra ?? raw;
          allCompras.push(c);
        }
        console.log(`[sync-nfe-entrada] Compras sit=${sitId} page ${page}/${totalPages}, ${items.length} items`);
        page++;
      }
    }
    
    const totalCompras = allCompras.length;
    console.log(`[sync-nfe-entrada] Total compras: ${totalCompras}, processing offset=${offset}, batch=${batchSize}`);

    // ── Step 3: Slice the batch to process ──
    const batchCompras = allCompras.slice(offset, offset + batchSize);
    const hasMore = offset + batchSize < totalCompras;
    const nextOffset = offset + batchSize;

    if (batchCompras.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, total_compras: totalCompras, processed: 0, has_more: false, next_offset: 0, produtos_processados: 0, upserted: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Step 3.5: On first batch, clear stale tributos data (preserve manual overrides) ──
    if (offset === 0) {
      console.log("[sync-nfe-entrada] Limpando dados antigos de tributos (preservando overrides manuais)...");
      const { error: delErr } = await supabase
        .from("fin_produto_tributos")
        .delete()
        .is("icms_aliquota_manual", null)
        .is("pis_aliquota_manual", null)
        .is("cofins_aliquota_manual", null)
        .is("ipi_aliquota_manual", null)
        .eq("sem_credito", false);
      if (delErr) {
        console.error("[sync-nfe-entrada] Erro ao limpar tributos antigos:", delErr.message);
      } else {
        console.log("[sync-nfe-entrada] Dados antigos limpos com sucesso");
      }
    }

    // ── Step 4: Build CNPJ → XMLs index from fin_nfe_xml_index ──
    const { data: xmlIndex } = await supabase
      .from("fin_nfe_xml_index")
      .select("chave, cnpj_emitente, nome_emitente, data_emissao, valor_total, valor_produtos, qtd_itens, storage_path");
    
    // Map CNPJ → list of indexed XMLs
    const cnpjToXmls = new Map<string, typeof xmlIndex>();
    for (const xi of (xmlIndex || [])) {
      if (!xi.cnpj_emitente) continue;
      const list = cnpjToXmls.get(xi.cnpj_emitente) || [];
      list.push(xi);
      cnpjToXmls.set(xi.cnpj_emitente, list);
    }
    console.log(`[sync-nfe-entrada] XML index loaded: ${xmlIndex?.length || 0} entries, ${cnpjToXmls.size} CNPJs`);

    // ── Step 5: Resolve fornecedor CNPJ from DB ──
    const productTaxMap = new Map<string, ProductTaxRecord>();
    let nfsProcessed = 0;
    let comprasWithNf = 0;
    let comprasWithoutNf = 0;
    let comprasMatchedByIndex = 0;
    let xmlsUsed = 0;

    const compraIds = batchCompras.map((c) => String(c.id || "")).filter(Boolean);
    const compraFornecedorMap = new Map<string, string>();
    const fornecedorIdToCnpj = new Map<string, string>();
    
    if (compraIds.length > 0) {
      const { data: comprasDb } = await supabase
        .from("gc_compras")
        .select("gc_id, nome_fornecedor, fornecedor_id")
        .in("gc_id", compraIds);

      const fornecedorGcIds = new Set<string>();
      for (const compraDb of comprasDb || []) {
        const nome = normalizeText(compraDb.nome_fornecedor);
        if (nome) compraFornecedorMap.set(String(compraDb.gc_id), nome);
        if (compraDb.fornecedor_id) fornecedorGcIds.add(String(compraDb.fornecedor_id));
      }

      // Fetch CNPJ for each fornecedor
      if (fornecedorGcIds.size > 0) {
        const fornIds = [...fornecedorGcIds];
        for (let fi = 0; fi < fornIds.length; fi += 100) {
          const chunk = fornIds.slice(fi, fi + 100);
          const { data: forns } = await supabase
            .from("fin_fornecedores")
            .select("gc_id, cpf_cnpj")
            .in("gc_id", chunk);
          for (const f of (forns || [])) {
            if (f.cpf_cnpj) {
              // Normalize CNPJ: only digits
              const cnpjDigits = f.cpf_cnpj.replace(/\D/g, "");
              if (cnpjDigits.length >= 11) {
                fornecedorIdToCnpj.set(f.gc_id, cnpjDigits);
              }
            }
          }
        }
      }
    }

    // ── Step 6: For each compra, fetch linked NFs OR match from XML index ──
    for (const compra of batchCompras) {
      const compraId = String(compra.id);
      const fornecedorNome = resolveCompraFornecedorNome(compra, compraFornecedorMap.get(compraId));
      const fornecedorId = String(compra.fornecedor_id || "");
      const fornecedorCnpj = fornecedorIdToCnpj.get(fornecedorId);
      
      const compraProdutos: CompraProduct[] = [];
      for (const p of (compra.produtos || [])) {
        const prod = (p as any).produto ?? p;
        if (prod?.produto_id) compraProdutos.push(prod);
      }
      if (compraProdutos.length === 0) continue;

      // Try GC NF API first
      const nfUrl = `${GC_BASE_URL}/api/notas_fiscais_produtos?compra_id=${compraId}&tipo_nf=0&limite=10`;
      const nfResp = await rateLimitedFetch(nfUrl, { headers: gcHeaders });
      
      let nfs: any[] = [];
      if (nfResp.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        const retry = await rateLimitedFetch(nfUrl, { headers: gcHeaders });
        if (retry.ok) {
          const retryJson = await retry.json();
          nfs = retryJson.data || [];
        }
      } else if (nfResp.ok) {
        const nfJson = await nfResp.json();
        nfs = nfJson.data || [];
      }

      const compraNumeroNf = String((compra as any).numero_nfe || "").replace(/\D/g, "");
      const linkedNfs = nfs.filter((raw) => {
        const nf = (raw as any).Nota_Fiscal_Produto ?? raw;
        const nfCompraId = String(nf.compra_id || "").trim();

        if (nfCompraId && nfCompraId === compraId) return true;

        if (compraNumeroNf) {
          const nfNumero = String(nf.numero_nf || "").replace(/\D/g, "");
          if (nfNumero && nfNumero === compraNumeroNf) return true;
        }

        return false;
      });

      if (linkedNfs.length > 0) {
        comprasWithNf++;
        nfsProcessed += linkedNfs.length;
        const used = await processNFs(linkedNfs, compra, compraProdutos, fornecedorNome, productTaxMap, supabase);
        xmlsUsed += used;
        continue;
      }

      if (nfs.length > 0) {
        console.log(`[sync-nfe-entrada] Ignorando ${nfs.length} NF(s) sem vínculo com compra ${compraId}`);
      }

      // ── Fallback: match XML from index by CNPJ do fornecedor ──
      if (fornecedorCnpj && cnpjToXmls.has(fornecedorCnpj)) {
        const candidateXmls = cnpjToXmls.get(fornecedorCnpj)!;
        
        // Try to find the best match by valor_total
        const compraValor = parseFloat(compra.valor_total || "0");
        let bestXml = candidateXmls[0];
        let bestDiff = Infinity;
        
        for (const candidate of candidateXmls) {
          const diff = Math.abs((candidate.valor_total || 0) - compraValor);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestXml = candidate;
          }
        }

        // Only match if value difference is reasonable (within 10% or R$5)
        const tolerance = Math.max(compraValor * 0.1, 5);
        if (bestDiff <= tolerance && bestXml) {
          console.log(`[sync-nfe-entrada] Index match ✓ compra ${compraId} "${fornecedorNome}" → XML chave=${bestXml.chave} (diff=R$${bestDiff.toFixed(2)})`);
          
          // Download the XML and process it
          const xmlContent = await tryDownloadXml(bestXml.chave, supabase);
          if (xmlContent) {
            xmlsUsed++;
            comprasMatchedByIndex++;
            
            // Build a synthetic NF from the XML index data
            const syntheticNf: NFData = {
              id: bestXml.chave,
              compra_id: compraId,
              tipo_nf: "0",
              numero_nf: "",
              chave: bestXml.chave,
              data_emissao: bestXml.data_emissao || "",
              situacao_nf: "Autorizada",
              cnpj_emitente: bestXml.cnpj_emitente || "",
              nome_emitente: bestXml.nome_emitente || fornecedorNome,
              fantasia_emitente: bestXml.nome_emitente || fornecedorNome,
              valor_total_nf: String(bestXml.valor_total || 0),
              valor_produtos: String(bestXml.valor_produtos || bestXml.valor_total || 0),
              base_icms: "0",
              valor_icms: "0",
              valor_pis: "0",
              valor_cofins: "0",
              valor_ipi: "0",
              valor_frete: "0",
              valor_fcp: "0",
              valor_icms_st: "0",
              valor_seguro: "0",
              valor_desconto: "0",
              valor_outros: "0",
              produtos: [],
            };
            
            await processNFs([{ Nota_Fiscal_Produto: syntheticNf }], compra, compraProdutos, fornecedorNome, productTaxMap, supabase);
            
            // Remove used XML from candidates to avoid double-matching
            const idx = candidateXmls.indexOf(bestXml);
            if (idx >= 0) candidateXmls.splice(idx, 1);
            continue;
          }
        }
      }

      comprasWithoutNf++;
    }

    console.log(`[sync-nfe-entrada] Batch done: com NF=${comprasWithNf}, sem NF=${comprasWithoutNf}, index_match=${comprasMatchedByIndex}, NFs=${nfsProcessed}, XMLs=${xmlsUsed}`);

    // ── Step 5: Upsert product tax profiles ──
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

    const records = [...productTaxMap.values()].map((r) => {
      const rec: Record<string, unknown> = {
        ...r,
        ultima_atualizacao: new Date().toISOString(),
      };
      if (existingManual.has(r.gc_produto_id)) {
        delete rec.sem_credito;
        delete rec.regime_fornecedor;
      }
      return rec;
    });

    let upserted = 0;
    const upsertBatchSize = 50;
    for (let i = 0; i < records.length; i += upsertBatchSize) {
      const batch = records.slice(i, i + upsertBatchSize);
      const { error } = await supabase
        .from("fin_produto_tributos")
        .upsert(batch as any, { onConflict: "gc_produto_id" });
      if (error) {
        console.error(`[sync-nfe-entrada] Upsert error batch ${i}:`, error.message);
      } else {
        upserted += batch.length;
      }
    }

    // Log only on last batch
    if (!hasMore) {
      await supabase.from("fin_sync_log").insert({
        tipo: "sync_nfe_entrada",
        status: "ok",
        payload: {
          total_compras: totalCompras,
          compras_com_nf: comprasWithNf,
          compras_sem_nf: comprasWithoutNf,
          nfs_processadas: nfsProcessed,
          xmls_usados: xmlsUsed,
          total_produtos: records.length,
        },
        resposta: { upserted },
      });
    }

    // ── Increment daily counter with actual GC calls made ──
    if (gcCallCount > 0) {
      await incrementDailyCounter(supabase, gcCallCount);
      console.log(`[sync-nfe-entrada] ${gcCallCount} chamadas GC neste batch`);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        total_compras: totalCompras,
        processed: batchCompras.length,
        offset,
        has_more: hasMore,
        next_offset: hasMore ? nextOffset : null,
        compras_com_nf: comprasWithNf,
        nfs_processadas: nfsProcessed,
        xmls_usados: xmlsUsed,
        produtos_processados: records.length,
        upserted,
        gc_calls_this_batch: gcCallCount,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[sync-nfe-entrada] Error:", (error as Error).message);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function normalizeText(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || text.toLowerCase() === "null" || text.toLowerCase() === "undefined") {
    return "";
  }
  return text;
}

function resolveCompraFornecedorNome(compra: any, nomeFornecedorDb?: string): string {
  return [
    nomeFornecedorDb,
    compra?.nome_fornecedor,
    compra?.fornecedor_nome,
    compra?.fornecedor?.nome,
    compra?.fornecedor?.razao_social,
    compra?.fornecedor?.nome_fantasia,
  ]
    .map(normalizeText)
    .find(Boolean) || "";
}

// ══════════════════════════════════════════════════════════════
//  Tenta baixar o XML do bucket nf-xmls pela chave da NF
// ══════════════════════════════════════════════════════════════
async function tryDownloadXml(chave: string, supabase: any): Promise<string | null> {
  if (!chave || chave.length < 44) return null;

  // Try common naming patterns
  const paths = [
    `${chave}.xml`,
    `NF-e${chave}.xml`,
    `NFe${chave}.xml`,
    `nfe-${chave}.xml`,
  ];

  for (const path of paths) {
    const { data, error } = await supabase.storage
      .from("nf-xmls")
      .download(path);
    if (!error && data) {
      const text = await data.text();
      if (text && text.includes("<nfeProc") || text.includes("<NFe") || text.includes("<infNFe")) {
        console.log(`[sync-nfe-entrada] XML encontrado: ${path}`);
        return text;
      }
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
//  Process NFs — agora com parsing XML real por item
// ══════════════════════════════════════════════════════════════
async function processNFs(
  nfs: any[],
  compra: any,
  compraProdutos: CompraProduct[],
  fornecedorNome: string,
  productTaxMap: Map<string, ProductTaxRecord>,
  supabase: any
): Promise<number> {
  let xmlsUsed = 0;
  const r = (v: number) => Math.round(v * 100) / 100;

  for (const nfRaw of nfs) {
    const nf: NFData = nfRaw.Nota_Fiscal_Produto ?? nfRaw;
    if (nf.situacao_nf === "Cancelada") continue;

    const valorProdutos = parseFloat(nf.valor_produtos) || 0;
    if (valorProdutos <= 0) continue;

    const freteTotal = parseFloat(nf.valor_frete) || 0;

    // ── Tentar buscar XML real do bucket ──
    const xmlContent = await tryDownloadXml(nf.chave, supabase);
    
    if (xmlContent) {
      // ═══════════════════════════════════════════════
      // MODO XML: impostos reais por item
      // ═══════════════════════════════════════════════
      xmlsUsed++;
      const xmlItems = parseXmlItems(xmlContent);
      const xmlFrete = getXmlFrete(xmlContent);
      const isSN = isXmlSimplesNacional(xmlContent, xmlItems);
      const totalVProd = xmlItems.reduce((s, i) => s + i.vProd, 0);

      // Match GC produtos -> XML items por VALOR do produto
      const nfProdutos: NFProduct[] = (nf.produtos || []).map((p: any) => p.produto ?? p);
      const usedXmlIndices = new Set<number>();

      for (const compraProd of compraProdutos) {
        const gcProdId = String(compraProd.produto_id);
        const nfProd = nfProdutos.find(np => String(np.produto_id) === gcProdId);
        
        // ── Estratégia de matching por VALOR ──
        // O valor total do produto na compra GC deve bater com vProd do XML
        const compraProdValor = parseFloat(nfProd?.valor_venda || compraProd.valor_total || "0") || 0;
        const compraProdQtd = parseFloat(nfProd?.quantidade || compraProd.quantidade || "1") || 1;
        const compraProdUnitario = compraProdQtd > 0 ? compraProdValor / compraProdQtd : compraProdValor;

        let xmlItem: XmlItemTax | undefined;
        let bestDiff = Infinity;
        let bestIdx = -1;

        // Fix #2: Tolerância aumentada para 5% do valor, mínimo R$0.50
        const matchTolerance = Math.max(compraProdValor * 0.05, 0.50);
        const unitTolerance = Math.max(compraProdUnitario * 0.05, 0.10);

        for (let i = 0; i < xmlItems.length; i++) {
          if (usedXmlIndices.has(i)) continue;
          const xi = xmlItems[i];
          
          // Match 1: valor total do produto (mais confiável)
          const diffTotal = Math.abs(xi.vProd - compraProdValor);
          if (diffTotal <= matchTolerance && diffTotal < bestDiff) {
            bestDiff = diffTotal;
            bestIdx = i;
            xmlItem = xi;
          }
          
          // Match 2: valor unitário + mesma quantidade
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

        // Match 3: código do produto no GC = cProd no XML
        if (!xmlItem && nfProd) {
          for (let i = 0; i < xmlItems.length; i++) {
            if (usedXmlIndices.has(i)) continue;
            if (xmlItems[i].cProd === nfProd.codigo_produto) {
              xmlItem = xmlItems[i];
              bestIdx = i;
              break;
            }
          }
        }

        // Match 3b: NCM match (mesmo NCM + valor mais próximo)
        if (!xmlItem && nfProd?.NCM) {
          let ncmBestDiff = Infinity;
          for (let i = 0; i < xmlItems.length; i++) {
            if (usedXmlIndices.has(i)) continue;
            if (xmlItems[i].NCM === nfProd.NCM) {
              const diff = Math.abs(xmlItems[i].vProd - compraProdValor);
              if (diff < ncmBestDiff) {
                ncmBestDiff = diff;
                xmlItem = xmlItems[i];
                bestIdx = i;
              }
            }
          }
        }

        // Match 4 (último recurso): se compra tem 1 produto e XML tem 1 item
        if (!xmlItem && compraProdutos.length === 1 && xmlItems.length === 1 && usedXmlIndices.size === 0) {
          xmlItem = xmlItems[0];
          bestIdx = 0;
        }

        // Fix #1: Se match falhou mas temos XML real → rateio proporcional pelos totais do XML
        if (!xmlItem || bestIdx < 0) {
          console.log(`[sync-nfe-entrada] XML match falhou p/ GC ${gcProdId} "${compraProd.nome_produto}" (valor=${compraProdValor}) → usando rateio proporcional do XML`);
          processItemXmlProportional(gcProdId, compraProd, nfProd, xmlItems, xmlFrete, isSN, nf, fornecedorNome, compra, productTaxMap);
          continue;
        }

        usedXmlIndices.add(bestIdx);
        console.log(`[sync-nfe-entrada] XML match ✓ GC "${compraProd.nome_produto}" → XML "${xmlItem.xProd}" (diff=R$${bestDiff.toFixed(2)})`);

        const qtd = xmlItem.qCom || 1;
        const valorUnit = xmlItem.vProd / qtd;
        const proporcao = totalVProd > 0 ? xmlItem.vProd / totalVProd : 0;
        const freteUnit = qtd > 0 ? (xmlFrete * proporcao) / qtd : 0;
        const ipiUnit = qtd > 0 ? xmlItem.ipi_vIPI / qtd : 0;

        // Crédito ICMS: usar alíquota REAL do XML
        // Para orig 1,2,3,6,7,8 (importados) a alíquota interestadual é 4% (Res. SF 13/2012)
        // O XML já traz o valor correto em vICMS
        const icmsUnit = isSN ? 0 : (qtd > 0 ? xmlItem.icms_vICMS / qtd : 0);
        const pisUnit = isSN ? 0 : (qtd > 0 ? xmlItem.pis_vPIS / qtd : 0);
        const cofinsUnit = isSN ? 0 : (qtd > 0 ? xmlItem.cofins_vCOFINS / qtd : 0);

        // Alíquota efetiva real sobre o valor do produto
        const icmsAliqReal = xmlItem.vProd > 0 ? (xmlItem.icms_vICMS / xmlItem.vProd) * 100 : 0;
        const pisAliqReal = xmlItem.pis_pPIS || (xmlItem.vProd > 0 ? (xmlItem.pis_vPIS / xmlItem.vProd) * 100 : 0);
        const cofinsAliqReal = xmlItem.cofins_pCOFINS || (xmlItem.vProd > 0 ? (xmlItem.cofins_vCOFINS / xmlItem.vProd) * 100 : 0);
        const ipiAliqReal = xmlItem.ipi_pIPI || (xmlItem.vProd > 0 ? (xmlItem.ipi_vIPI / xmlItem.vProd) * 100 : 0);
        const freteRate = totalVProd > 0 ? (xmlFrete / totalVProd) * 100 : 0;

        // Base ICMS como % do valor do produto (para detectar redução de base)
        const icmsBasePerc = xmlItem.vProd > 0 ? (xmlItem.icms_vBC / xmlItem.vProd) * 100 : 100;

        const custoEfetivo = valorUnit + ipiUnit + freteUnit - icmsUnit - pisUnit - cofinsUnit;

        const existing = productTaxMap.get(gcProdId);
        if (existing && existing.nf_data_emissao > (nf.data_emissao || "")) {
          continue;
        }

        productTaxMap.set(gcProdId, {
          gc_produto_id: gcProdId,
          nome_produto: xmlItem.xProd || compraProd.nome_produto || "",
          ncm: xmlItem.NCM || "",
          cfop: xmlItem.CFOP || "",
          nf_gc_id: String(nf.id || ""),
          nf_numero: nf.numero_nf || "",
          nf_chave: nf.chave || "",
          nf_data_emissao: nf.data_emissao || "",
          compra_gc_id: String(compra.id || ""),
          fornecedor_nome: fornecedorNome || nf.fantasia_emitente || nf.nome_emitente || "",
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

        console.log(`[sync-nfe-entrada] XML ✓ ${gcProdId} "${xmlItem.xProd}" → ICMS=${r(icmsAliqReal)}% PIS=${r(pisAliqReal)}% COFINS=${r(cofinsAliqReal)}% IPI=${r(ipiAliqReal)}%`);
      }
    } else {
      // ═══════════════════════════════════════════════
      // MODO FALLBACK: distribuição proporcional (sem XML)
      // ═══════════════════════════════════════════════
      console.log(`[sync-nfe-entrada] XML não encontrado para NF chave=${nf.chave || "sem_chave"}, usando proporção`);
      
      const nfProdutos: NFProduct[] = (nf.produtos || []).map((p: any) => p.produto ?? p);
      for (const compraProd of compraProdutos) {
        const gcProdId = String(compraProd.produto_id);
        const nfProd = nfProdutos.find(np => String(np.produto_id) === gcProdId);
        processItemProportional(gcProdId, compraProd, nfProd, nf, freteTotal, fornecedorNome, compra, productTaxMap);
      }
    }
  }

  return xmlsUsed;
}

// ── Fallback: método proporcional original (quando não há XML) ──
function processItemProportional(
  gcProdId: string,
  compraProd: CompraProduct,
  nfProd: NFProduct | undefined,
  nf: NFData,
  freteTotal: number,
  fornecedorNome: string,
  compra: any,
  productTaxMap: Map<string, ProductTaxRecord>
) {
  const r = (v: number) => Math.round(v * 100) / 100;
  const valorProdutos = parseFloat(nf.valor_produtos) || 0;
  const icmsTotal = parseFloat(nf.valor_icms) || 0;
  const baseIcms = parseFloat(nf.base_icms) || 0;
  const pisTotal = parseFloat(nf.valor_pis) || 0;
  const cofinsTotal = parseFloat(nf.valor_cofins) || 0;
  const ipiTotal = parseFloat(nf.valor_ipi) || 0;

  const isSimplesNacional = valorProdutos > 0 && baseIcms === 0 && icmsTotal === 0 && pisTotal === 0 && cofinsTotal === 0;

  const icmsRate = baseIcms > 0 ? (icmsTotal / baseIcms) * 100 : 0;
  const pisRate = valorProdutos > 0 ? (pisTotal / valorProdutos) * 100 : 0;
  const cofinsRate = valorProdutos > 0 ? (cofinsTotal / valorProdutos) * 100 : 0;
  const ipiRate = valorProdutos > 0 ? (ipiTotal / valorProdutos) * 100 : 0;
  const freteRate = valorProdutos > 0 ? (freteTotal / valorProdutos) * 100 : 0;

  const qtd = parseFloat(nfProd?.quantidade || compraProd.quantidade || "1") || 1;
  const valorProd = parseFloat(nfProd?.valor_venda || compraProd.valor_total || "0") || 0;
  const proporcao = valorProdutos > 0 ? valorProd / valorProdutos : 1;
  const valorUnit = qtd > 0 ? valorProd / qtd : valorProd;

  const icmsUnit = isSimplesNacional ? 0 : (qtd > 0 ? (icmsTotal * proporcao) / qtd : 0);
  const pisUnit = isSimplesNacional ? 0 : (qtd > 0 ? (pisTotal * proporcao) / qtd : 0);
  const cofinsUnit = isSimplesNacional ? 0 : (qtd > 0 ? (cofinsTotal * proporcao) / qtd : 0);
  const ipiUnit = qtd > 0 ? (ipiTotal * proporcao) / qtd : 0;
  const freteUnit = qtd > 0 ? (freteTotal * proporcao) / qtd : 0;
  const custoEfetivo = valorUnit + ipiUnit + freteUnit - icmsUnit - pisUnit - cofinsUnit;

  const existing = productTaxMap.get(gcProdId);
  if (existing && existing.nf_data_emissao > (nf.data_emissao || "")) return;

  productTaxMap.set(gcProdId, {
    gc_produto_id: gcProdId,
    nome_produto: nfProd?.nome_produto || compraProd.nome_produto || "",
    ncm: nfProd?.NCM || "",
    cfop: nfProd?.cfop || "",
    nf_gc_id: String(nf.id || ""),
    nf_numero: nf.numero_nf || "",
    nf_chave: nf.chave || "",
    nf_data_emissao: nf.data_emissao || "",
    compra_gc_id: String(compra.id || ""),
    fornecedor_nome: fornecedorNome || nf.fantasia_emitente || nf.nome_emitente || "",
    regime_fornecedor: isSimplesNacional ? "simples_nacional" : "normal",
    sem_credito: isSimplesNacional,
    icms_aliquota: isSimplesNacional ? 0 : r(icmsRate),
    icms_base: isSimplesNacional ? 0 : (baseIcms > 0 ? r((baseIcms / valorProdutos) * 100) : 100),
    pis_aliquota: isSimplesNacional ? 0 : r(pisRate),
    cofins_aliquota: isSimplesNacional ? 0 : r(cofinsRate),
    ipi_aliquota: r(ipiRate),
    frete_percentual: r(freteRate),
    valor_unitario_nf: r(valorUnit),
    valor_icms_unit: r(icmsUnit),
    valor_pis_unit: r(pisUnit),
    valor_cofins_unit: r(cofinsUnit),
    valor_ipi_unit: r(ipiUnit),
    valor_frete_unit: r(freteUnit),
    custo_efetivo_unit: r(custoEfetivo),
  });
}
