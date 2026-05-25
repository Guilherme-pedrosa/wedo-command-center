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

// ── Types locais ──
interface CompraItem {
  produto_gc_id: string | null;
  nome_produto: string;
  quantidade: number;
  valor_custo: number;
  valor_total: number;
  unidade: string | null;
  origem_vinculo: string | null;
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
  // Bloco 1.9: campos extras de NF para cálculo real
  q_com: number;
  v_un_com: number;
  q_trib: number;
  v_un_trib: number;
  fator_conversao: number;
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
      nItem, cProd, xProd, NCM, CFOP,
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

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ── Step 1: Carrega compras candidatas (numero_nfe IS NOT NULL) ──
    const { count: totalCount, error: countErr } = await supabase
      .from("gc_compras")
      .select("*", { count: "exact", head: true })
      .not("numero_nfe", "is", null);
    if (countErr) throw new Error(`count compras: ${countErr.message}`);

    const totalCompras = totalCount ?? 0;

    const { data: comprasRaw, error: comprasErr } = await supabase
      .from("gc_compras")
      .select("gc_id, codigo, numero_nfe, cnpj_fornecedor, fornecedor_id, nome_fornecedor, data, valor_total, valor_produtos, valor_frete")
      .not("numero_nfe", "is", null)
      .order("data", { ascending: false, nullsFirst: false })
      .range(offset, offset + batchSize - 1);
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
        .select("compra_gc_id, produto_gc_id, nome_produto, quantidade, valor_custo, valor_total, unidade, origem_vinculo")
        .in("compra_gc_id", chunk);
      for (const it of itens || []) {
        const arr = itensByCompra.get(String(it.compra_gc_id)) || [];
        arr.push({
          produto_gc_id: it.produto_gc_id,
          nome_produto: it.nome_produto || "",
          quantidade: Number(it.quantidade) || 1,
          valor_custo: Number(it.valor_custo) || 0,
          valor_total: Number(it.valor_total) || 0,
          unidade: it.unidade,
          origem_vinculo: it.origem_vinculo,
        });
        itensByCompra.set(String(it.compra_gc_id), arr);
      }
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

    // ── Step 3: Carrega índice de XMLs (cabe em RAM) ──
    const { data: xmlIndex } = await supabase
      .from("fin_nfe_xml_index")
      .select("chave, numero_nf, cnpj_emitente, nome_emitente, data_emissao, valor_total, valor_produtos, qtd_itens, storage_path");

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

    // ── Step 4: Limpa tributos antigos (preserva manuais) — só no offset=0 ──
    if (offset === 0 && !dryRun) {
      await supabase
        .from("fin_produto_tributos")
        .delete()
        .is("icms_aliquota_manual", null)
        .is("pis_aliquota_manual", null)
        .is("cofins_aliquota_manual", null)
        .is("ipi_aliquota_manual", null)
        .eq("sem_credito", false);
      // Limpa pendências antigas para reprocessar
      await supabase.from("fin_nfe_match_pendentes").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    }

    // ── Step 5: Matcher determinístico ──
    const productTaxMap = new Map<string, ProductTaxRecord>();
    const pendentesNovos: any[] = [];
    let nivel1 = 0;
    let nivel2 = 0;
    let semMatch = 0;
    let xmlsLidos = 0;
    let xmlsFalha = 0;
    const semMatchAmostra: any[] = [];

    for (const compra of compras) {
      const cnpj = normCnpj(compra.cnpj_fornecedor);
      const numero = normNumeroNf(compra.numero_nfe);

      if (!cnpj) {
        semMatch++;
        registrarPendente(pendentesNovos, semMatchAmostra, compra, "sem_cnpj_compra", []);
        continue;
      }
      if (!numero) {
        semMatch++;
        registrarPendente(pendentesNovos, semMatchAmostra, compra, "sem_numero_nfe", []);
        continue;
      }

      // Nível 1: cnpj + numero
      let matched: XmlIndexRow | null = null;
      let matchRuleTag = "";
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
      } else {
        // Nível 2: cnpj + valor (tolerância 1% ou R$5)
        const candidatos = byCnpj.get(cnpj) || [];
        if (candidatos.length === 0) {
          semMatch++;
          registrarPendente(pendentesNovos, semMatchAmostra, compra, "cnpj_sem_xml", []);
          continue;
        }
        const tol = Math.max(compra.valor_total * 0.01, 5);
        let best: XmlIndexRow | null = null;
        let bestDiff = Infinity;
        for (const x of candidatos) {
          const diff = Math.abs((x.valor_total || 0) - compra.valor_total);
          if (diff <= tol && diff < bestDiff) {
            bestDiff = diff;
            best = x;
          }
        }
        if (best) {
          matched = best;
          matchRuleTag = "cnpj_valor_frouxo";
          nivel2++;
        } else {
          semMatch++;
          const top3 = candidatos
            .slice()
            .sort(
              (a, b) =>
                Math.abs((a.valor_total || 0) - compra.valor_total) -
                Math.abs((b.valor_total || 0) - compra.valor_total),
            )
            .slice(0, 3)
            .map((x) => ({
              chave: x.chave,
              numero_nf: x.numero_nf,
              valor_total: x.valor_total,
              data_emissao: x.data_emissao,
              diff: Math.abs((x.valor_total || 0) - compra.valor_total),
            }));
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

      processarXml(xml, matched, compra, matchRuleTag, productTaxMap);
    }

    // ── Step 6: Upsert tributos ──
    let upserted = 0;
    if (!dryRun && productTaxMap.size > 0) {
      const ids = [...productTaxMap.keys()];
      const manuais = new Set<string>();
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const { data } = await supabase
          .from("fin_produto_tributos")
          .select("gc_produto_id, icms_aliquota_manual, pis_aliquota_manual, cofins_aliquota_manual, sem_credito")
          .in("gc_produto_id", chunk);
        for (const row of data || []) {
          if (
            row.sem_credito ||
            row.icms_aliquota_manual != null ||
            row.pis_aliquota_manual != null ||
            row.cofins_aliquota_manual != null
          )
            manuais.add(row.gc_produto_id);
        }
      }
      const records = [...productTaxMap.values()].map((r) => {
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
        pendentes_registrados: pendentesNovos.length,
        sem_match_amostra: semMatchAmostra.slice(0, 5),
        dry_run: dryRun,
        gc_api_calls: 0,
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
//  Processa XML real e gera ProductTaxRecord por item da compra
// ══════════════════════════════════════════════════════════════
function processarXml(
  xml: string,
  xmlMeta: XmlIndexRow,
  compra: CompraRow,
  matchRuleTag: string,
  productTaxMap: Map<string, ProductTaxRecord>,
) {
  const r = (v: number) => Math.round(v * 100) / 100;
  const xmlItems = parseXmlItems(xml);
  if (xmlItems.length === 0) return;
  const xmlFrete = getXmlFrete(xml);
  const isSN = isXmlSimplesNacional(xml, xmlItems);
  const totalVProd = xmlItems.reduce((s, i) => s + i.vProd, 0);
  const meta = getXmlMeta(xml);

  const compraItens = compra.itens;
  const usedXmlIdx = new Set<number>();

  for (const item of compraItens) {
    // só grava tributos para itens com gc_produto_id
    const gcProdId = item.produto_gc_id;
    if (!gcProdId) continue;

    const compraValorTotal = item.valor_total || item.valor_custo * item.quantidade;
    const compraQtd = item.quantidade || 1;
    const compraUnit = compraQtd > 0 ? compraValorTotal / compraQtd : compraValorTotal;

    let pick: { xi: XmlItemTax; idx: number; rule: string } | null = null;
    let bestDiff = Infinity;
    const tolTotal = Math.max(compraValorTotal * 0.05, 0.5);
    const tolUnit = Math.max(compraUnit * 0.05, 0.1);

    // 1) match por valor total
    for (let i = 0; i < xmlItems.length; i++) {
      if (usedXmlIdx.has(i)) continue;
      const xi = xmlItems[i];
      const diff = Math.abs(xi.vProd - compraValorTotal);
      if (diff <= tolTotal && diff < bestDiff) {
        bestDiff = diff;
        pick = { xi, idx: i, rule: "valor_total" };
      }
    }

    // 2) match por unitário+qtd
    if (!pick) {
      for (let i = 0; i < xmlItems.length; i++) {
        if (usedXmlIdx.has(i)) continue;
        const xi = xmlItems[i];
        const sameQtd = Math.abs(xi.qCom - compraQtd) < 0.01;
        const diff = Math.abs(xi.vUnCom - compraUnit);
        if (sameQtd && diff <= tolUnit && diff < bestDiff) {
          bestDiff = diff;
          pick = { xi, idx: i, rule: "valor_unit_qtd" };
        }
      }
    }

    // 3) 1x1
    if (!pick && compraItens.length === 1 && xmlItems.length === 1 && usedXmlIdx.size === 0) {
      pick = { xi: xmlItems[0], idx: 0, rule: "unico_1x1" };
    }

    if (!pick) {
      // rateio proporcional pelas médias do XML
      processarRateio(
        gcProdId,
        item,
        xmlItems,
        xmlFrete,
        isSN,
        xmlMeta,
        compra,
        meta,
        productTaxMap,
        matchRuleTag,
      );
      continue;
    }

    usedXmlIdx.add(pick.idx);
    const xi = pick.xi;
    const qtd = xi.qCom || 1;
    const valorUnit = xi.vProd / qtd;
    const proporcao = totalVProd > 0 ? xi.vProd / totalVProd : 0;
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

    // ── Bloco 1.9: cálculo de custo variável real (usa qTrib quando disponível) ──
    const qComEst = xi.qCom || 0;
    const qTribEst = xi.qTrib || 0;
    const fatorConversao = (qComEst > 0 && qTribEst > 0) ? (qTribEst / qComEst) : 1;
    const qtdEstoqueReal = qTribEst > 0 ? qTribEst : (qComEst || 1);
    // custo total do item: vProd + IPI + frete (rateado) + seg + outro + ST + FCP-ST + DIFAL - desc - créditos (se houver)
    const custoTotalItem =
      xi.vProd
      + xi.ipi_vIPI
      + (xmlFrete * proporcao)
      + xi.vSeg
      + xi.vOutro
      + xi.icms_vICMSST
      + xi.icms_vFCPST
      + xi.icms_vICMSUFDest
      - xi.vDesc
      - (isSN ? 0 : xi.icms_vICMS)
      - (isSN ? 0 : xi.pis_vPIS)
      - (isSN ? 0 : xi.cofins_vCOFINS);
    const custoVariavelReal = qtdEstoqueReal > 0 ? custoTotalItem / qtdEstoqueReal : custoTotalItem;

    const existing = productTaxMap.get(gcProdId);
    if (existing && existing.nf_data_emissao > (xmlMeta.data_emissao || meta.data_emissao || "")) continue;

    productTaxMap.set(gcProdId, {
      gc_produto_id: gcProdId,
      nome_produto: xi.xProd || item.nome_produto || "",
      ncm: xi.NCM || "",
      cfop: xi.CFOP || "",
      nf_gc_id: meta.chave || xmlMeta.chave,
      nf_numero: meta.numero_nf || xmlMeta.numero_nf || "",
      nf_chave: xmlMeta.chave,
      nf_data_emissao: xmlMeta.data_emissao || meta.data_emissao || "",
      compra_gc_id: compra.gc_id,
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
      match_rule: `${matchRuleTag}+${pick.rule}`,
      // Bloco 1.9
      q_com: r(qComEst),
      v_un_com: r(xi.vUnCom),
      q_trib: r(qTribEst),
      v_un_trib: r(xi.vUnTrib),
      fator_conversao: Math.round(fatorConversao * 10000) / 10000,
      v_seg: r(xi.vSeg),
      v_outro: r(xi.vOutro),
      v_desc: r(xi.vDesc),
      v_icms_st: r(xi.icms_vICMSST),
      v_fcp_st: r(xi.icms_vFCPST),
      v_icms_uf_dest: r(xi.icms_vICMSUFDest),
      v_icms_uf_remet: r(xi.icms_vICMSUFRemet),
      custo_variavel_real: r(custoVariavelReal),
    });
  }
}

function processarRateio(
  gcProdId: string,
  item: CompraItem,
  xmlItems: XmlItemTax[],
  xmlFrete: number,
  isSN: boolean,
  xmlMeta: XmlIndexRow,
  compra: CompraRow,
  meta: { chave: string; numero_nf: string; data_emissao: string; nome_emitente: string },
  productTaxMap: Map<string, ProductTaxRecord>,
  matchRuleTag: string,
) {
  const r = (v: number) => Math.round(v * 100) / 100;
  const totalVProd = xmlItems.reduce((s, i) => s + i.vProd, 0);
  const totalICMS = xmlItems.reduce((s, i) => s + i.icms_vICMS, 0);
  const totalPIS = xmlItems.reduce((s, i) => s + i.pis_vPIS, 0);
  const totalCOFINS = xmlItems.reduce((s, i) => s + i.cofins_vCOFINS, 0);
  const totalIPI = xmlItems.reduce((s, i) => s + i.ipi_vIPI, 0);
  const totalBaseICMS = xmlItems.reduce((s, i) => s + i.icms_vBC, 0);
  const avgIcmsAliq = totalVProd > 0 ? (totalICMS / totalVProd) * 100 : 0;
  const avgPisAliq = totalVProd > 0 ? (totalPIS / totalVProd) * 100 : 0;
  const avgCofinsAliq = totalVProd > 0 ? (totalCOFINS / totalVProd) * 100 : 0;
  const avgIpiAliq = totalVProd > 0 ? (totalIPI / totalVProd) * 100 : 0;
  const freteRate = totalVProd > 0 ? (xmlFrete / totalVProd) * 100 : 0;
  const icmsBasePerc = totalVProd > 0 ? (totalBaseICMS / totalVProd) * 100 : 100;

  const ref = xmlItems[0];
  const qtd = item.quantidade || 1;
  const valorProd = item.valor_total || item.valor_custo * qtd;
  const valorUnit = qtd > 0 ? valorProd / qtd : valorProd;
  const icmsUnit = isSN ? 0 : valorUnit * (avgIcmsAliq / 100);
  const pisUnit = isSN ? 0 : valorUnit * (avgPisAliq / 100);
  const cofinsUnit = isSN ? 0 : valorUnit * (avgCofinsAliq / 100);
  const ipiUnit = valorUnit * (avgIpiAliq / 100);
  const freteUnit = valorUnit * (freteRate / 100);
  const custoEfetivo = valorUnit + ipiUnit + freteUnit - icmsUnit - pisUnit - cofinsUnit;

  const existing = productTaxMap.get(gcProdId);
  if (existing && existing.nf_data_emissao > (xmlMeta.data_emissao || "")) return;

  productTaxMap.set(gcProdId, {
    gc_produto_id: gcProdId,
    nome_produto: item.nome_produto || "",
    ncm: ref?.NCM || "",
    cfop: ref?.CFOP || "",
    nf_gc_id: meta.chave || xmlMeta.chave,
    nf_numero: meta.numero_nf || xmlMeta.numero_nf || "",
    nf_chave: xmlMeta.chave,
    nf_data_emissao: xmlMeta.data_emissao || "",
    compra_gc_id: compra.gc_id,
    fornecedor_nome: xmlMeta.nome_emitente || compra.nome_fornecedor || "",
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
    match_rule: `${matchRuleTag}+xml_rateio`,
  });
}
