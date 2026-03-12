import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";
const MIN_DELAY_MS = 350;
let lastCallTime = 0;

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  }
  lastCallTime = Date.now();
  return fetch(url, options);
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Accept batch params: offset (0-based index into compras list), batch_size (default 80)
    const body = await req.json().catch(() => ({}));
    const offset = Number(body.offset) || 0;
    const batchSize = Math.min(Number(body.batch_size) || 80, 120); // cap at 120

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

    // ── Step 2: Fetch ALL compra IDs (paginated) — only IDs + fornecedor + produtos ──
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

    // ── Step 4: For each compra in batch, fetch linked NFs de entrada ──
    const productTaxMap = new Map<string, ProductTaxRecord>();
    let nfsProcessed = 0;
    let comprasWithNf = 0;
    let comprasWithoutNf = 0;

    const compraIds = batchCompras.map((c) => String(c.id || "")).filter(Boolean);
    const compraFornecedorMap = new Map<string, string>();
    if (compraIds.length > 0) {
      const { data: comprasDb } = await supabase
        .from("gc_compras")
        .select("gc_id, nome_fornecedor")
        .in("gc_id", compraIds);

      for (const compraDb of comprasDb || []) {
        const nome = normalizeText(compraDb.nome_fornecedor);
        if (nome) {
          compraFornecedorMap.set(String(compraDb.gc_id), nome);
        }
      }
    }

    for (const compra of batchCompras) {
      const compraId = String(compra.id);
      const fornecedorNome = resolveCompraFornecedorNome(compra, compraFornecedorMap.get(compraId));
      
      const compraProdutos: CompraProduct[] = [];
      for (const p of (compra.produtos || [])) {
        const prod = (p as any).produto ?? p;
        if (prod?.produto_id) compraProdutos.push(prod);
      }
      if (compraProdutos.length === 0) continue;

      const nfUrl = `${GC_BASE_URL}/api/notas_fiscais_produtos?compra_id=${compraId}&tipo_nf=0&limite=10`;
      const nfResp = await rateLimitedFetch(nfUrl, { headers: gcHeaders });
      
      if (nfResp.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        const retry = await rateLimitedFetch(nfUrl, { headers: gcHeaders });
        if (!retry.ok) continue;
        const retryJson = await retry.json();
        processNFs(retryJson.data || [], compra, compraProdutos, fornecedorNome, productTaxMap);
        nfsProcessed += (retryJson.data || []).length;
        if ((retryJson.data || []).length > 0) comprasWithNf++;
        else comprasWithoutNf++;
        continue;
      }
      if (!nfResp.ok) {
        console.error(`[sync-nfe-entrada] NF fetch error for compra ${compraId}: ${nfResp.status}`);
        comprasWithoutNf++;
        continue;
      }

      const nfJson = await nfResp.json();
      const nfs = nfJson.data || [];
      
      if (nfs.length === 0) {
        comprasWithoutNf++;
        continue;
      }

      comprasWithNf++;
      nfsProcessed += nfs.length;
      processNFs(nfs, compra, compraProdutos, fornecedorNome, productTaxMap);
    }

    console.log(`[sync-nfe-entrada] Batch done: com NF=${comprasWithNf}, sem NF=${comprasWithoutNf}, NFs=${nfsProcessed}`);

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
          total_produtos: records.length,
        },
        resposta: { upserted },
      });
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
        produtos_processados: records.length,
        upserted,
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

// ── Process NFs and extract per-product tax data ──
function processNFs(
  nfs: any[],
  compra: any,
  compraProdutos: CompraProduct[],
  fornecedorNome: string,
  productTaxMap: Map<string, ProductTaxRecord>
) {
  for (const nfRaw of nfs) {
    const nf: NFData = nfRaw.Nota_Fiscal_Produto ?? nfRaw;
    if (nf.situacao_nf === "Cancelada") continue;

    const valorProdutos = parseFloat(nf.valor_produtos) || 0;
    if (valorProdutos <= 0) continue;

    const icmsTotal = parseFloat(nf.valor_icms) || 0;
    const baseIcms = parseFloat(nf.base_icms) || 0;
    const pisTotal = parseFloat(nf.valor_pis) || 0;
    const cofinsTotal = parseFloat(nf.valor_cofins) || 0;
    const ipiTotal = parseFloat(nf.valor_ipi) || 0;
    const freteTotal = parseFloat(nf.valor_frete) || 0;

    const isSimplesNacional = valorProdutos > 0 && baseIcms === 0 && icmsTotal === 0 && pisTotal === 0 && cofinsTotal === 0;

    const icmsRate = baseIcms > 0 ? (icmsTotal / baseIcms) * 100 : 0;
    const pisRate = valorProdutos > 0 ? (pisTotal / valorProdutos) * 100 : 0;
    const cofinsRate = valorProdutos > 0 ? (cofinsTotal / valorProdutos) * 100 : 0;
    const ipiRate = valorProdutos > 0 ? (ipiTotal / valorProdutos) * 100 : 0;
    const freteRate = valorProdutos > 0 ? (freteTotal / valorProdutos) * 100 : 0;

    const nfProdutos: NFProduct[] = (nf.produtos || []).map((p: any) => p.produto ?? p);
    if (nfProdutos.length === 0) continue;

    const nfProdMap = new Map<string, NFProduct>();
    for (const np of nfProdutos) {
      if (np.produto_id) nfProdMap.set(String(np.produto_id), np);
    }

    for (const compraProd of compraProdutos) {
      const gcProdId = String(compraProd.produto_id);
      const nfProd = nfProdMap.get(gcProdId);
      
      const nomeProduto = nfProd?.nome_produto || compraProd.nome_produto || "";
      const ncm = nfProd?.NCM || "";
      const cfop = nfProd?.cfop || "";
      const qtd = parseFloat(nfProd?.quantidade || compraProd.quantidade || "1") || 1;
      const valorProd = parseFloat(nfProd?.valor_venda || compraProd.valor_total || "0") || 0;
      const proporcao = valorProdutos > 0 ? valorProd / valorProdutos : 1 / nfProdutos.length;
      const valorUnit = qtd > 0 ? valorProd / qtd : valorProd;

      const icmsUnit = isSimplesNacional ? 0 : (qtd > 0 ? (icmsTotal * proporcao) / qtd : 0);
      const pisUnit = isSimplesNacional ? 0 : (qtd > 0 ? (pisTotal * proporcao) / qtd : 0);
      const cofinsUnit = isSimplesNacional ? 0 : (qtd > 0 ? (cofinsTotal * proporcao) / qtd : 0);
      const ipiUnit = qtd > 0 ? (ipiTotal * proporcao) / qtd : 0;
      const freteUnit = qtd > 0 ? (freteTotal * proporcao) / qtd : 0;

      const custoEfetivo = valorUnit + ipiUnit + freteUnit - icmsUnit - pisUnit - cofinsUnit;

      const existing = productTaxMap.get(gcProdId);
      if (existing && existing.nf_data_emissao > (nf.data_emissao || "")) {
        continue;
      }

      const r = (v: number) => Math.round(v * 100) / 100;

      productTaxMap.set(gcProdId, {
        gc_produto_id: gcProdId,
        nome_produto: nomeProduto,
        ncm,
        cfop,
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
  }
}
