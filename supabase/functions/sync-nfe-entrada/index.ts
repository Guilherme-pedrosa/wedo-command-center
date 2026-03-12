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

interface GCNFProduto {
  id: string;
  compra_id: string;
  tipo_nf: string;
  numero_nf: string;
  data_emissao: string;
  situacao_nf: string;
  // Tax totals
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
  // Emitente (fornecedor na NF de entrada)
  nome_emitente: string;
  cnpj_emitente: string;
  // Produtos
  produtos: Array<{
    produto_id: string;
    codigo_produto: string;
    nome_produto: string;
    quantidade: string;
    valor_venda: string;
    NCM: string;
    cfop: string;
  }>;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
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

    // Fetch all NFs de produto from GC (paginated)
    const allNFs: GCNFProduto[] = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const url = `${GC_BASE_URL}/api/notas_fiscais_produtos?limite=100&pagina=${page}&tipo_nf=0`;
      const resp = await rateLimitedFetch(url, { headers: gcHeaders });

      if (resp.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!resp.ok) {
        console.error(`[sync-nfe-entrada] GC error: ${resp.status}`);
        break;
      }

      const json = await resp.json();
      const items = json.data || [];
      totalPages = json.meta?.total_paginas || 1;

      // Filter only entrada NFs (tipo_nf=0) that are approved
      for (const nf of items) {
        const item = nf.Nota_Fiscal_Produto || nf;
        if (item.situacao_nf === "Cancelada") continue;
        allNFs.push(item);
      }

      console.log(`[sync-nfe-entrada] Page ${page}/${totalPages}, got ${items.length} NFs`);
      page++;
    }

    console.log(`[sync-nfe-entrada] Total NFs de entrada: ${allNFs.length}`);

    // Process each NF and extract per-product tax profiles
    const productTaxMap = new Map<string, {
      gc_produto_id: string;
      nome_produto: string;
      ncm: string;
      nf_gc_id: string;
      nf_numero: string;
      nf_data_emissao: string;
      fornecedor_nome: string;
      // Rates
      icms_aliquota: number;
      icms_base: number;
      pis_aliquota: number;
      cofins_aliquota: number;
      ipi_aliquota: number;
      frete_percentual: number;
      // Unit values
      valor_unitario_nf: number;
      valor_icms_unit: number;
      valor_pis_unit: number;
      valor_cofins_unit: number;
      valor_ipi_unit: number;
      valor_frete_unit: number;
      custo_efetivo_unit: number;
    }>();

    for (const nf of allNFs) {
      const valorProdutos = parseFloat(nf.valor_produtos) || 0;
      const valorTotalNF = parseFloat(nf.valor_total_nf) || 0;
      if (valorProdutos <= 0) continue;

      // NF-level tax totals
      const icmsTotal = parseFloat(nf.valor_icms) || 0;
      const baseIcms = parseFloat(nf.base_icms) || 0;
      const pisTotal = parseFloat(nf.valor_pis) || 0;
      const cofinsTotal = parseFloat(nf.valor_cofins) || 0;
      const ipiTotal = parseFloat(nf.valor_ipi) || 0;
      const freteTotal = parseFloat(nf.valor_frete) || 0;

      // Effective NF-level rates
      const icmsRate = baseIcms > 0 ? (icmsTotal / baseIcms) * 100 : 0;
      const pisRate = valorProdutos > 0 ? (pisTotal / valorProdutos) * 100 : 0;
      const cofinsRate = valorProdutos > 0 ? (cofinsTotal / valorProdutos) * 100 : 0;
      const ipiRate = valorProdutos > 0 ? (ipiTotal / valorProdutos) * 100 : 0;
      const freteRate = valorProdutos > 0 ? (freteTotal / valorProdutos) * 100 : 0;

      // Distribute proportionally to each product
      const produtos = nf.produtos || [];
      if (produtos.length === 0) continue;

      for (const prod of produtos) {
        const prodId = prod.produto_id;
        if (!prodId) continue;

        const qtd = parseFloat(prod.quantidade) || 1;
        const valorProd = parseFloat(prod.valor_venda) || 0;
        const proporcao = valorProdutos > 0 ? valorProd / valorProdutos : 1 / produtos.length;
        const valorUnit = qtd > 0 ? valorProd / qtd : valorProd;

        // Proportional tax per this product line
        const icmsUnit = qtd > 0 ? (icmsTotal * proporcao) / qtd : 0;
        const pisUnit = qtd > 0 ? (pisTotal * proporcao) / qtd : 0;
        const cofinsUnit = qtd > 0 ? (cofinsTotal * proporcao) / qtd : 0;
        const ipiUnit = qtd > 0 ? (ipiTotal * proporcao) / qtd : 0;
        const freteUnit = qtd > 0 ? (freteTotal * proporcao) / qtd : 0;

        // Custo efetivo = valor + IPI + frete - crédito ICMS - crédito PIS - crédito COFINS
        const custoEfetivo = valorUnit + ipiUnit + freteUnit - icmsUnit - pisUnit - cofinsUnit;

        // Keep only the most recent NF per product (by date)
        const existing = productTaxMap.get(prodId);
        if (existing && existing.nf_data_emissao > (nf.data_emissao || "")) {
          continue; // keep the newer one
        }

        productTaxMap.set(prodId, {
          gc_produto_id: prodId,
          nome_produto: prod.nome_produto || "",
          ncm: prod.NCM || "",
          nf_gc_id: nf.id,
          nf_numero: nf.numero_nf || "",
          nf_data_emissao: nf.data_emissao || "",
          fornecedor_nome: nf.nome_emitente || "",
          icms_aliquota: Math.round(icmsRate * 100) / 100,
          icms_base: baseIcms > 0 ? Math.round((baseIcms / valorProdutos) * 10000) / 100 : 100,
          pis_aliquota: Math.round(pisRate * 100) / 100,
          cofins_aliquota: Math.round(cofinsRate * 100) / 100,
          ipi_aliquota: Math.round(ipiRate * 100) / 100,
          frete_percentual: Math.round(freteRate * 100) / 100,
          valor_unitario_nf: Math.round(valorUnit * 100) / 100,
          valor_icms_unit: Math.round(icmsUnit * 100) / 100,
          valor_pis_unit: Math.round(pisUnit * 100) / 100,
          valor_cofins_unit: Math.round(cofinsUnit * 100) / 100,
          valor_ipi_unit: Math.round(ipiUnit * 100) / 100,
          valor_frete_unit: Math.round(freteUnit * 100) / 100,
          custo_efetivo_unit: Math.round(custoEfetivo * 100) / 100,
        });
      }
    }

    // Upsert all product tax profiles
    const records = [...productTaxMap.values()].map((r) => ({
      ...r,
      ultima_atualizacao: new Date().toISOString(),
    }));

    let upserted = 0;
    const batchSize = 50;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const { error } = await supabase
        .from("fin_produto_tributos")
        .upsert(batch, { onConflict: "gc_produto_id" });

      if (error) {
        console.error(`[sync-nfe-entrada] Upsert error batch ${i}:`, error.message);
      } else {
        upserted += batch.length;
      }
    }

    // Log
    await supabase.from("fin_sync_log").insert({
      tipo: "sync_nfe_entrada",
      status: "ok",
      payload: { total_nfs: allNFs.length, total_produtos: records.length },
      resposta: { upserted },
    });

    return new Response(
      JSON.stringify({
        ok: true,
        total_nfs: allNFs.length,
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
