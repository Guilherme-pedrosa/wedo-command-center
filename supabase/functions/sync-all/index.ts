import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// redeploy: 2026-03-13-v4-consolidated

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";
const AUVO_BASE = "https://api.auvo.com.br/v2";
const MIN_DELAY_MS = 350;
const DEFAULT_SYNC_WINDOW_DAYS = 90;
let lastCallTime = 0;

// ── Shared rate limiter (single instance for all GC calls) ──
async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  }
  lastCallTime = Date.now();
  return fetch(url, options);
}

// ── GC paginated fetch ──
async function fetchAllPages(
  endpoint: string,
  gcHeaders: Record<string, string>,
  extraParams?: Record<string, string>
): Promise<{ records: any[]; pages: number }> {
  const allRecords: any[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const params: Record<string, string> = { limite: "100", pagina: String(page), ...extraParams };
    const url = `${GC_BASE_URL}${endpoint}?${new URLSearchParams(params).toString()}`;
    const response = await rateLimitedFetch(url, { headers: gcHeaders });

    if (response.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (!response.ok) {
      console.error(`[sync-all] ${endpoint} error: ${response.status}`);
      break;
    }

    const data = await response.json();
    const records = Array.isArray(data?.data) ? data.data : [];
    totalPages = data?.meta?.total_paginas || 1;
    allRecords.push(...records);
    page++;
  }

  return { records: allRecords, pages: totalPages };
}

// ── Helpers ──
function extrairOsCodigo(descricao: string | null | undefined): string | null {
  if (!descricao) return null;
  const match = descricao.match(/Ordem de serviço de nº\s*(\d+)/i);
  return match ? match[1] : null;
}

function inferirTipo(descricao: string | null | undefined): string {
  if (!descricao) return "outro";
  if (/ordem de serviço/i.test(descricao)) return "os";
  if (/venda/i.test(descricao)) return "venda";
  if (/contrato/i.test(descricao)) return "contrato";
  return "outro";
}

function inferirOrigem(descricao?: string | null): string {
  if (!descricao) return "outro";
  if (/ordem de serviço/i.test(descricao)) return "gc_os";
  if (/venda/i.test(descricao)) return "gc_venda";
  if (/contrato/i.test(descricao)) return "gc_contrato";
  return "outro";
}

type FinLancamentoStatus = "pendente" | "pago" | "vencido" | "cancelado";

function coerceLancamentoStatus(value: unknown, fallback: FinLancamentoStatus = "pendente"): FinLancamentoStatus {
  const normalized = String(value ?? "").toLowerCase().trim();

  if (["liquidado", "pago", "paga", "baixado", "recebido", "quitado"].includes(normalized)) {
    return "pago";
  }

  if (["cancelado", "cancelada", "cancelar"].includes(normalized)) {
    return "cancelado";
  }

  if (normalized === "vencido") {
    return "vencido";
  }

  if (normalized === "pendente") {
    return "pendente";
  }

  return fallback;
}

function normalizeLancamentoStatus(item: Record<string, any>): FinLancamentoStatus {
  const rawStatus = String(item.status || item.situacao || item.nome_situacao || item.status_pagamento || "").toLowerCase().trim();
  const liquidado = item.liquidado === "1" || item.liquidado === 1 || item.liquidado === true;

  if (liquidado) {
    return "pago";
  }

  const coerced = coerceLancamentoStatus(rawStatus);
  if (coerced !== "pendente" || rawStatus === "pendente") {
    return coerced;
  }

  const dataVencimento = item.data_vencimento ? new Date(item.data_vencimento) : null;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  if (dataVencimento && !Number.isNaN(dataVencimento.getTime())) {
    dataVencimento.setHours(0, 0, 0, 0);
    if (dataVencimento < hoje) return "vencido";
  }

  return "pendente";
}

// ── Hardcoded situação IDs (static, never change) ──
// OS: all EXECUTADO statuses
const OS_SITUACAO_IDS = [
  "7261986",  // EXECUTADO POR CONTRATO
  "7116099",  // EXECUTADO - AGUARDANDO NEGOCIAÇÃO FINANCEIRA
  "7063724",  // EXECUTADO - AGUARDANDO PAGAMENTO
  "7124107",  // EXECUTADO COM NOTA EMITIDA
  "7438044",  // EXECUTADO EM GARANTIA
  "7535001",  // EXECUTADO -PATRIMÔNIO
  "7720756",  // EXECUTADO - FINANCEIRO SEPARADO
  "8677491",  // EXECUTADO - CIGAM
  "8760417",  // EXECUTADO - LIBERADO P/ FATURAMENTO (CIGAM SEM BAIXA ESTOQ)
  "8889036",  // EXECUTADO - FECHADO CHAMADO
];

// Vendas: Concretizado + Venda Futura (hardcoded to avoid situacoes_vendas API call)
let VENDAS_SITUACAO_IDS: string[] = [];

// Compras: Finalizado (mercadoria chegou) + Comprado - AG CHEGADA (hardcoded to avoid situacoes_compras API call)
let COMPRAS_SITUACAO_IDS: string[] = [];

// ── OS mapping ──
function mapOsRecord(os: Record<string, unknown>) {
  const osId = String(os.id || "");
  const osCodigo = String(os.codigo || "");
  if (!osId || !osCodigo) return null;

  let dataSaida: string | null = null;
  const rawDataSaida = String(os.data_saida || "");
  if (rawDataSaida) {
    const match = rawDataSaida.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) dataSaida = match[1];
  }
  if (!dataSaida) {
    const fallback = String(os.modificado_em || os.data_entrada || "");
    if (fallback) {
      const match = fallback.match(/^(\d{4}-\d{2}-\d{2})/);
      if (match) dataSaida = match[1];
    }
  }

  return {
    os_id: osId,
    os_codigo: osCodigo,
    orc_codigo: osCodigo,
    nome_cliente: String(os.nome_cliente || "") || null,
    nome_situacao: String(os.nome_situacao || ""),
    nome_vendedor: String(os.nome_vendedor || "") || null,
    data_saida: dataSaida,
    valor_total: parseFloat(String(os.valor_total || "0")) || null,
    valor_servicos: parseFloat(String(os.valor_servicos || "0")) || null,
    valor_pecas: parseFloat(String(os.valor_produtos || "0")) || null,
    numero_os: osCodigo,
    built_at: new Date().toISOString(),
  };
}

// Build mapping from GC IDs to local UUIDs
async function buildPcCcFpMaps(supabase: any): Promise<{
  pcMap: Record<string, string>;
  ccMap: Record<string, string>;
  fpMap: Record<string, string>;
}> {
  const [{ data: pcs }, { data: ccs }, { data: fps }] = await Promise.all([
    supabase.from("fin_plano_contas").select("id, gc_id").not("gc_id", "is", null),
    supabase.from("fin_centros_custo").select("id, codigo").not("codigo", "is", null),
    supabase.from("fin_formas_pagamento").select("id, gc_id").not("gc_id", "is", null),
  ]);
  const pcMap: Record<string, string> = {};
  for (const pc of pcs ?? []) { if (pc.gc_id) pcMap[pc.gc_id] = pc.id; }
  const ccMap: Record<string, string> = {};
  for (const cc of ccs ?? []) { if (cc.codigo) ccMap[cc.codigo] = cc.id; }
  const fpMap: Record<string, string> = {};
  for (const fp of fps ?? []) { if (fp.gc_id) fpMap[fp.gc_id] = fp.id; }
  return { pcMap, ccMap, fpMap };
}

// ═══════════════════════════════════════════════════════════════
// MODULE 1: Sync OS (inline)
// ═══════════════════════════════════════════════════════════════
async function syncOS(
  gcHeaders: Record<string, string>,
  supabase: any
): Promise<any> {
  const start = Date.now();
  let totalFetched = 0;
  let upserted = 0;
  let errors = 0;
  const statusCounts: Record<string, number> = {};

  for (const sitId of OS_SITUACAO_IDS) {
    let page = 1;
    let totalPages = 999;

    while (page <= totalPages) {
      const params = new URLSearchParams({
        limite: "100",
        pagina: String(page),
        situacao_id: sitId,
      });
      const url = `${GC_BASE_URL}/api/ordens_servicos?${params.toString()}`;
      const response = await rateLimitedFetch(url, { headers: gcHeaders });

      if (response.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!response.ok) {
        console.error(`[sync-all/os] GC API error sit=${sitId}: ${response.status}`);
        errors++;
        break;
      }

      const data = await response.json();
      const records = Array.isArray(data?.data) ? data.data : [];
      totalPages = data?.meta?.total_paginas || 1;

      const batch = [];
      for (const os of records) {
        totalFetched++;
        const nomeSituacao = String(os.nome_situacao || "");
        statusCounts[nomeSituacao] = (statusCounts[nomeSituacao] || 0) + 1;
        const mapped = mapOsRecord(os);
        if (mapped) batch.push(mapped);
        else errors++;
      }

      if (batch.length > 0) {
        const { error: upsertErr, count } = await supabase
          .from("os_index")
          .upsert(batch, { onConflict: "os_id,orc_codigo", count: "exact" });
        if (upsertErr) {
          console.error(`[sync-all/os] Upsert error: ${upsertErr.message}`);
          errors += batch.length;
        } else {
          upserted += count || batch.length;
        }
      }

      console.log(`[sync-all/os] sit=${sitId} page ${page}/${totalPages} — ${records.length} recs`);
      page++;
    }
  }

  await supabase.from("os_index_meta").upsert({
    id: 1, status: "done", total_os: upserted, built_at: new Date().toISOString(),
  });

  return { status: errors > 0 ? "partial" : "ok", totalFetched, upserted, errors, statusCounts, duration_ms: Date.now() - start };
}

// ═══════════════════════════════════════════════════════════════
// MODULE 2: Sync Vendas (inline)
// ═══════════════════════════════════════════════════════════════
async function syncVendas(
  gcHeaders: Record<string, string>,
  supabase: any
): Promise<any> {
  const start = Date.now();

  // Lazy-load situacao IDs (only once, then cached in memory for this invocation)
  if (VENDAS_SITUACAO_IDS.length === 0) {
    console.log("[sync-all/vendas] Fetching situacoes_vendas (one-time)...");
    const sitResp = await rateLimitedFetch(`${GC_BASE_URL}/api/situacoes_vendas`, { headers: gcHeaders });
    if (sitResp.ok) {
      const sitData = await sitResp.json();
      const situacoes = Array.isArray(sitData?.data) ? sitData.data : [];
      for (const sit of situacoes) {
        const nome = String(sit.nome || "").toLowerCase().trim();
        if (nome === "concretizado" || nome === "concretizada" || nome === "venda futura") {
          VENDAS_SITUACAO_IDS.push(String(sit.id));
          console.log(`[sync-all/vendas] Found situacao: ${sit.nome} (id=${sit.id})`);
        }
      }
    }
    if (VENDAS_SITUACAO_IDS.length === 0) {
      return { status: "error", error: "No Concretizado/Venda Futura situacao_ids found", duration_ms: Date.now() - start };
    }
  }

  let totalFetched = 0;
  let upserted = 0;
  let errors = 0;

  for (const sitId of VENDAS_SITUACAO_IDS) {
    let page = 1;
    let totalPages = 999;

    while (page <= totalPages) {
      const params: Record<string, string> = {
        limite: "100",
        pagina: String(page),
        situacao_id: sitId,
        tipo: "produto",
      };

      const url = `${GC_BASE_URL}/api/vendas?${new URLSearchParams(params).toString()}`;
      const response = await rateLimitedFetch(url, { headers: gcHeaders });

      if (response.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!response.ok) {
        console.error(`[sync-all/vendas] GC API error sit=${sitId}: ${response.status}`);
        errors++;
        break;
      }

      const data = await response.json();
      const records = Array.isArray(data?.data) ? data.data : [];
      totalPages = data?.meta?.total_paginas || 1;

      const batch = [];
      for (const venda of records) {
        totalFetched++;
        const gcId = String(venda.id || "");
        if (!gcId) { errors++; continue; }

        let dataVenda: string | null = null;
        const rawData = String(venda.data || "");
        if (rawData) {
          const match = rawData.match(/^(\d{4}-\d{2}-\d{2})/);
          if (match) dataVenda = match[1];
        }

        batch.push({
          gc_id: gcId,
          codigo: String(venda.codigo || ""),
          tipo: String(venda.tipo || "produto"),
          nome_cliente: String(venda.nome_cliente || venda.cliente_nome || "") || null,
          cliente_id: String(venda.cliente_id || venda.cliente_codigo || "") || null,
          nome_situacao: String(venda.nome_situacao || venda.situacao_nome || ""),
          situacao_id: sitId,
          data: dataVenda,
          valor_total: parseFloat(String(venda.valor_total || "0")) || null,
          valor_produtos: parseFloat(String(venda.valor_produtos || "0")) || null,
          valor_servicos: parseFloat(String(venda.valor_servicos || "0")) || null,
          desconto: parseFloat(String(venda.desconto || "0")) || 0,
          observacao: String(venda.observacao || "") || null,
          gc_payload_raw: venda,
          last_synced_at: new Date().toISOString(),
        });
      }

      if (batch.length > 0) {
        const { error: upsertErr, count } = await supabase
          .from("gc_vendas")
          .upsert(batch, { onConflict: "gc_id", count: "exact" });
        if (upsertErr) {
          console.error(`[sync-all/vendas] Upsert error: ${upsertErr.message}`);
          errors += batch.length;
        } else {
          upserted += count || batch.length;
        }
      }

      console.log(`[sync-all/vendas] sit=${sitId} page ${page}/${totalPages} — ${records.length} recs`);
      page++;
    }
  }

  return { status: errors > 0 ? "partial" : "ok", totalFetched, upserted, errors, duration_ms: Date.now() - start };
}

// ═══════════════════════════════════════════════════════════════
// MODULE 3: Sync Compras (inline)
// ═══════════════════════════════════════════════════════════════
async function syncCompras(
  gcHeaders: Record<string, string>,
  supabase: any
): Promise<any> {
  const start = Date.now();

  // Lazy-load situacao IDs
  if (COMPRAS_SITUACAO_IDS.length === 0) {
    console.log("[sync-all/compras] Fetching situacoes_compras (one-time)...");
    const sitResp = await rateLimitedFetch(`${GC_BASE_URL}/api/situacoes_compras`, { headers: gcHeaders });
    if (sitResp.ok) {
      const sitData = await sitResp.json();
      const situacoes = Array.isArray(sitData?.data) ? sitData.data : [];
      for (const sit of situacoes) {
        const nome = String(sit.nome || "").toLowerCase().trim();
        if (
          (nome.includes("finalizado") && nome.includes("mercadoria chegou")) ||
          (nome.includes("comprado") && nome.includes("ag chegada"))
        ) {
          COMPRAS_SITUACAO_IDS.push(String(sit.id));
          console.log(`[sync-all/compras] Found situacao: ${sit.nome} (id=${sit.id})`);
        }
      }
    }
    if (COMPRAS_SITUACAO_IDS.length === 0) {
      return { status: "error", error: "No matching compras situacao_ids found", duration_ms: Date.now() - start };
    }
  }

  let totalFetched = 0;
  let upserted = 0;
  let errors = 0;

  for (const currentSitId of COMPRAS_SITUACAO_IDS) {
    let page = 1;
    let totalPages = 999;

    while (page <= totalPages) {
      const params: Record<string, string> = {
        limite: "100",
        pagina: String(page),
        situacao_id: currentSitId,
      };

      const url = `${GC_BASE_URL}/api/compras?${new URLSearchParams(params).toString()}`;
      const response = await rateLimitedFetch(url, { headers: gcHeaders });

      if (response.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!response.ok) {
        console.error(`[sync-all/compras] GC API error: ${response.status}`);
        errors++;
        break;
      }

      const data = await response.json();
      const records = Array.isArray(data?.data) ? data.data : [];
      totalPages = data?.meta?.total_paginas || 1;

      const batch = [];
      for (const compra of records) {
        totalFetched++;
        const c = (compra as any).Compra ?? compra;
        const gcId = String(c.id || "");
        if (!gcId) { errors++; continue; }

        let dataCompra: string | null = null;
        const rawData = String(c.data_emissao || c.data || c.data_compra || "");
        if (rawData) {
          const match = rawData.match(/^(\d{4}-\d{2}-\d{2})/);
          if (match) dataCompra = match[1];
        }

        let cadastradoEm: string | null = null;
        const rawCad = String(c.cadastrado_em || c.created || c.data_cadastro || "");
        if (rawCad) {
          const match = rawCad.match(/^(\d{4}-\d{2}-\d{2})/);
          if (match) cadastradoEm = match[1];
        }

        batch.push({
          gc_id: gcId,
          codigo: String(c.codigo || c.numero || ""),
          nome_fornecedor: String(c.nome_fornecedor || c.fornecedor_nome || "") || null,
          fornecedor_id: String(c.fornecedor_id || "") || null,
          nome_situacao: String(c.nome_situacao || c.situacao_nome || ""),
          situacao_id: currentSitId,
          data: dataCompra,
          cadastrado_em: cadastradoEm,
          valor_total: parseFloat(String(c.valor_total || "0")) || null,
          valor_produtos: parseFloat(String(c.valor_produtos || "0")) || null,
          valor_frete: parseFloat(String(c.valor_frete || "0")) || null,
          desconto: parseFloat(String(c.desconto || "0")) || 0,
          observacao: String(c.observacao || c.observacoes || "") || null,
          gc_payload_raw: compra,
          last_synced_at: new Date().toISOString(),
        });
      }

      if (batch.length > 0) {
        const { error: upsertErr, count } = await supabase
          .from("gc_compras")
          .upsert(batch, { onConflict: "gc_id", count: "exact" });
        if (upsertErr) {
          console.error(`[sync-all/compras] Upsert error: ${upsertErr.message}`);
          errors += batch.length;
        } else {
          upserted += count || batch.length;
        }
      }

      console.log(`[sync-all/compras] sit=${currentSitId} page ${page}/${totalPages} — ${records.length} recs`);
      page++;
    }
  }

  return { status: errors > 0 ? "partial" : "ok", totalFetched, upserted, errors, duration_ms: Date.now() - start };
}

// ═══════════════════════════════════════════════════════════════
// MODULE 4: Sync Auvo Expenses (inline)
// ═══════════════════════════════════════════════════════════════
const AUVO_TYPE_IDS = [48782, 48784, 49032, 48783, 48799, 50758];

async function syncAuvo(supabase: any): Promise<any> {
  const start = Date.now();
  const apiKey = Deno.env.get("AUVO_API_KEY");
  const apiToken = Deno.env.get("AUVO_USER_TOKEN");

  if (!apiKey || !apiToken) {
    return { status: "skipped", reason: "AUVO credentials not configured", duration_ms: 0 };
  }

  try {
    // Login
    const loginRes = await fetch(`${AUVO_BASE}/login/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, apiToken }),
    });
    if (!loginRes.ok) throw new Error(`Auvo login failed: ${loginRes.status}`);
    const loginJson = await loginRes.json();
    const token = loginJson?.result?.accessToken ?? loginJson?.result?.token ?? loginJson?.token;
    if (!token) throw new Error("Auvo login: accessToken not found");

    const now = new Date();
    const mes = now.getMonth() + 1;
    const ano = now.getFullYear();
    const mesStr = String(mes).padStart(2, "0");
    const lastDay = new Date(ano, mes, 0).getDate();
    const startDate = `${ano}-${mesStr}-01`;
    const endDate = `${ano}-${mesStr}-${lastDay}`;

    let totalSynced = 0;
    const byType: Record<string, { count: number; total: number }> = {};

    for (const typeId of AUVO_TYPE_IDS) {
      const all: any[] = [];
      let page = 1;
      const pageSize = 100;

      while (true) {
        const filter = JSON.stringify({ startDate, endDate, type: typeId });
        const url = `${AUVO_BASE}/expenses/?paramFilter=${encodeURIComponent(filter)}&page=${page}&pageSize=${pageSize}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          console.error(`[sync-all/auvo] expenses error typeId=${typeId} page=${page}: ${res.status}`);
          break;
        }
        const json = await res.json();
        const results = json?.result?.entityList ?? json?.result?.entities ?? [];
        if (!Array.isArray(results) || results.length === 0) break;
        all.push(...results);
        if (results.length < pageSize) break;
        page++;
      }

      let typeTotal = 0;
      if (all.length > 0) {
        const rows = all.map((e: any) => ({
          auvo_id: e.id,
          type_id: typeId,
          type_name: e.expenseTypeName || e.typeName || null,
          user_to_id: e.userToID || e.userToId || null,
          user_to_name: e.userToName || null,
          expense_date: e.date?.split("T")[0] || startDate,
          amount: parseFloat(e.value || e.amount || "0"),
          description: e.description || null,
          attachment_url: e.attachmentUrl || e.receiptUrl || null,
          synced_at: new Date().toISOString(),
        }));

        typeTotal = rows.reduce((s: number, r: any) => s + (r.amount || 0), 0);

        for (let i = 0; i < rows.length; i += 50) {
          const batch = rows.slice(i, i + 50);
          const { error } = await supabase
            .from("auvo_expenses_sync")
            .upsert(batch, { onConflict: "auvo_id" });
          if (error) console.error(`[sync-all/auvo] Upsert error typeId=${typeId}:`, error.message);
        }

        totalSynced += all.length;
      }

      byType[String(typeId)] = { count: all.length, total: typeTotal };
    }

    return { status: "ok", synced: totalSynced, by_type: byType, duration_ms: Date.now() - start };
  } catch (err) {
    return { status: "error", error: (err as Error).message, duration_ms: Date.now() - start };
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const results: Record<string, any> = {};

  try {
    // Parse optional date range
    let bodyDataInicio: string | undefined;
    let bodyDataFim: string | undefined;
    try {
      const body = await req.json();
      bodyDataInicio = body?.data_inicio;
      bodyDataFim = body?.data_fim;
    } catch { /* no body */ }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if ((bodyDataInicio && !dateRegex.test(bodyDataInicio)) || (bodyDataFim && !dateRegex.test(bodyDataFim))) {
      return new Response(JSON.stringify({
        error: "Parâmetros inválidos. Use data_inicio e data_fim no formato YYYY-MM-DD.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!gcAccessToken || !gcSecretToken) {
      return new Response(JSON.stringify({ error: "GC credentials not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Default to an incremental window to keep the sync under the platform timeout.
    let dataInicio = bodyDataInicio;
    let dataFim = bodyDataFim;
    let dateSource = "request";

    if (!dataFim) {
      dataFim = new Date().toISOString().split("T")[0];
      if (bodyDataInicio) {
        dateSource = "request_completed_with_today";
      }
    }

    if (!dataInicio) {
      const endDate = new Date(`${dataFim}T00:00:00Z`);
      endDate.setUTCDate(endDate.getUTCDate() - (DEFAULT_SYNC_WINDOW_DAYS - 1));
      dataInicio = endDate.toISOString().split("T")[0];
      dateSource = bodyDataFim ? "request_completed_with_default_window" : "default_90d_window";
    }

    if (!dataInicio || !dataFim) {
      return new Response(JSON.stringify({
        error: "Informe data_inicio e data_fim. Não foi possível inferir o período automaticamente.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (dataInicio > dataFim) {
      return new Response(JSON.stringify({
        error: "Período inválido: data_inicio maior que data_fim.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const finDateParams: Record<string, string> = {
      data_inicio: dataInicio,
      data_fim: dataFim,
    };
    results.date_range = { ...finDateParams, source: dateSource };
    console.log(`[sync-all] Date range (${dateSource}): ${dataInicio} → ${dataFim}`);

    const gcHeaders: Record<string, string> = {
      "access-token": gcAccessToken,
      "secret-access-token": gcSecretToken,
      "Content-Type": "application/json",
    };

    // ═══════════════════════════════════════════════════════════
    // SEQUENTIAL execution to share the single rate limiter
    // (GC API has 350ms between calls — parallel would conflict)
    // ═══════════════════════════════════════════════════════════

    // 1. Sync OS
    console.log("[sync-all] ── Module 1/6: OS ──");
    results.os = await syncOS(gcHeaders, supabase);
    console.log(`[sync-all] OS done: ${results.os.upserted} upserted (${results.os.duration_ms}ms)`);

    // 2. Sync Vendas
    console.log("[sync-all] ── Module 2/6: Vendas ──");
    results.vendas = await syncVendas(gcHeaders, supabase);
    console.log(`[sync-all] Vendas done: ${results.vendas.upserted} upserted (${results.vendas.duration_ms}ms)`);

    // 3. Sync Compras
    console.log("[sync-all] ── Module 3/6: Compras ──");
    results.compras = await syncCompras(gcHeaders, supabase);
    console.log(`[sync-all] Compras done: ${results.compras.upserted} upserted (${results.compras.duration_ms}ms)`);

    // 4. Sync Auvo (different API, no GC rate limit conflict — run in parallel with next GC module)
    // But since Auvo is fast and doesn't use GC rate limiter, we run it here
    console.log("[sync-all] ── Module 4/6: Auvo ──");
    results.auvo = await syncAuvo(supabase);
    console.log(`[sync-all] Auvo done (${results.auvo.duration_ms}ms)`);

    // ── Build PC/CC/FP maps for fin_* upserts ──
    const { pcMap, ccMap, fpMap } = await buildPcCcFpMaps(supabase);

    // Fetch cancelled gc_ids to skip during fin_* upserts
    const [{ data: cancelledRecs }, { data: cancelledPags }] = await Promise.all([
      supabase.from("fin_recebimentos").select("gc_id").eq("status", "cancelado").not("gc_id", "is", null),
      supabase.from("fin_pagamentos").select("gc_id").eq("status", "cancelado").not("gc_id", "is", null),
    ]);
    const cancelledRecGcIds = new Set((cancelledRecs ?? []).map((r: any) => r.gc_id));
    const cancelledPagGcIds = new Set((cancelledPags ?? []).map((p: any) => p.gc_id));

    // Fetch fornecedores for recipient_document backfill
    const { data: fornecedores } = await supabase
      .from("fin_fornecedores")
      .select("gc_id, cpf_cnpj")
      .not("cpf_cnpj", "is", null);
    const fornDocMap: Record<string, string> = {};
    for (const f of (fornecedores ?? []) as any[]) {
      if (f.cpf_cnpj) fornDocMap[f.gc_id] = f.cpf_cnpj;
    }

    // 5. Sync GC Recebimentos
    console.log("[sync-all] ── Module 5/6: Recebimentos ──");
    const recStart = Date.now();
    try {
      const { records: recRecords } = await fetchAllPages("/api/recebimentos", gcHeaders, finDateParams);
      let gcRecUpserted = 0;
      let finRecUpserted = 0;
      let recErrors = 0;
      const recErrorMessages = new Set<string>();

      for (let i = 0; i < recRecords.length; i += 50) {
        const rawBatch = recRecords.slice(i, i + 50);

        const gcBatch = rawBatch.map((item: any) => ({
          gc_id: String(item.id),
          gc_codigo: item.codigo || null,
          descricao: item.descricao || null,
          os_codigo: (item.descricao?.match(/Ordem de serviço de nº\s*(\d+)/i)?.[1]) || null,
          tipo: /ordem de serviço/i.test(item.descricao || "") ? "os" : /venda/i.test(item.descricao || "") ? "venda" : "outro",
          valor: parseFloat(item.valor_total) || 0,
          cliente_id: item.cliente_id || null,
          nome_cliente: item.nome_cliente || null,
          plano_contas_id: item.plano_contas_id || null,
          nome_plano_conta: item.nome_plano_conta || null,
          conta_bancaria_id: item.conta_bancaria_id || null,
          nome_conta_bancaria: item.nome_conta_bancaria || null,
          forma_pagamento_id: item.forma_pagamento_id || null,
          nome_forma_pagamento: item.nome_forma_pagamento || null,
          centro_custo_id: item.centro_custo_id || null,
          nome_centro_custo: item.nome_centro_custo || null,
          data_vencimento: item.data_vencimento || null,
          data_competencia: item.data_competencia || null,
          data_liquidacao: item.data_liquidacao || null,
          liquidado: item.liquidado === "1",
          gc_payload_raw: item,
          last_synced_at: new Date().toISOString(),
        }));

        const { error: gcErr } = await supabase
          .from("gc_recebimentos")
          .upsert(gcBatch, { onConflict: "gc_id" });
        if (gcErr) {
          console.error(`[sync-all] gc_recebimentos upsert error: ${gcErr.message}`);
          recErrorMessages.add(`gc_recebimentos: ${gcErr.message}`);
          recErrors += gcBatch.length;
        } else {
          gcRecUpserted += gcBatch.length;
        }

        const finBatch = rawBatch
          .filter((item: any) => !cancelledRecGcIds.has(String(item.id)))
          .map((item: any) => ({
            gc_id: String(item.id),
            gc_codigo: item.codigo || null,
            gc_payload_raw: item,
            descricao: item.descricao ?? "Sem descrição",
            os_codigo: extrairOsCodigo(item.descricao),
            tipo: inferirTipo(item.descricao),
            origem: inferirOrigem(item.descricao),
            valor: parseFloat(item.valor_total ?? "0"),
            cliente_gc_id: item.cliente_id ?? null,
            nome_cliente: item.nome_cliente ?? null,
            plano_contas_id: item.plano_contas_id ? (pcMap[item.plano_contas_id] ?? null) : null,
            centro_custo_id: item.centro_custo_id ? (ccMap[item.centro_custo_id] ?? null) : null,
            forma_pagamento_id: item.forma_pagamento_id ? (fpMap[item.forma_pagamento_id] ?? null) : null,
            data_vencimento: item.data_vencimento || null,
            data_competencia: item.data_competencia || null,
            data_liquidacao: item.data_liquidacao || null,
            liquidado: item.liquidado === "1",
            status: normalizeLancamentoStatus(item),
            last_synced_at: new Date().toISOString(),
          }));

        if (finBatch.length > 0) {
          const { error: finErr } = await supabase
            .from("fin_recebimentos")
            .upsert(finBatch, { onConflict: "gc_id" });
          if (finErr) {
            console.error(`[sync-all] fin_recebimentos upsert error: ${finErr.message}`);
            recErrorMessages.add(`fin_recebimentos: ${finErr.message}`);
            recErrors += finBatch.length;
          } else {
            finRecUpserted += finBatch.length;
          }
        }
      }

      results.recebimentos = {
        status: recErrors > 0 ? "partial" : "ok",
        fetched: recRecords.length,
        gc_upserted: gcRecUpserted,
        fin_upserted: finRecUpserted,
        errors: recErrors,
        error_messages: [...recErrorMessages],
        duration_ms: Date.now() - recStart,
      };
      console.log(`[sync-all] Recebimentos done: ${recRecords.length} fetched, gc=${gcRecUpserted}, fin=${finRecUpserted} (${Date.now() - recStart}ms)`);
    } catch (err) {
      results.recebimentos = { status: "error", error: (err as Error).message, duration_ms: Date.now() - recStart };
      console.error(`[sync-all] recebimentos error: ${(err as Error).message}`);
    }

    // 6. Sync GC Pagamentos
    console.log("[sync-all] ── Module 6/6: Pagamentos ──");
    const pagStart = Date.now();
    try {
      const { records: pagRecords } = await fetchAllPages("/api/pagamentos", gcHeaders, finDateParams);
      let gcPagUpserted = 0;
      let finPagUpserted = 0;
      let pagErrors = 0;

      for (let i = 0; i < pagRecords.length; i += 50) {
        const rawBatch = pagRecords.slice(i, i + 50);

        const gcBatch = rawBatch.map((item: any) => ({
          gc_id: String(item.id),
          gc_codigo: item.codigo || null,
          descricao: item.descricao || null,
          valor: parseFloat(item.valor_total) || 0,
          fornecedor_id: item.fornecedor_id || null,
          nome_fornecedor: item.nome_fornecedor || null,
          plano_contas_id: item.plano_contas_id || null,
          nome_plano_conta: item.nome_plano_conta || null,
          conta_bancaria_id: item.conta_bancaria_id || null,
          nome_conta_bancaria: item.nome_conta_bancaria || null,
          forma_pagamento_id: item.forma_pagamento_id || null,
          nome_forma_pagamento: item.nome_forma_pagamento || null,
          centro_custo_id: item.centro_custo_id || null,
          nome_centro_custo: item.nome_centro_custo || null,
          data_vencimento: item.data_vencimento || null,
          data_competencia: item.data_competencia || null,
          data_liquidacao: item.data_liquidacao || null,
          liquidado: item.liquidado === "1",
          gc_payload_raw: item,
          last_synced_at: new Date().toISOString(),
        }));

        const { error: gcErr } = await supabase
          .from("gc_pagamentos")
          .upsert(gcBatch, { onConflict: "gc_id" });
        if (gcErr) {
          console.error(`[sync-all] gc_pagamentos upsert error: ${gcErr.message}`);
          pagErrors += gcBatch.length;
        } else {
          gcPagUpserted += gcBatch.length;
        }

        const finBatch = rawBatch
          .filter((item: any) => !cancelledPagGcIds.has(String(item.id)))
          .map((item: any) => ({
            gc_id: String(item.id),
            gc_codigo: item.codigo || null,
            gc_payload_raw: item,
            descricao: item.descricao ?? "Sem descrição",
            os_codigo: extrairOsCodigo(item.descricao),
            tipo: inferirTipo(item.descricao),
            origem: inferirOrigem(item.descricao),
            valor: parseFloat(item.valor_total ?? "0"),
            fornecedor_gc_id: item.fornecedor_id ?? null,
            nome_fornecedor: item.nome_fornecedor ?? null,
            recipient_document: item.fornecedor_id ? (fornDocMap[item.fornecedor_id] ?? null) : null,
            plano_contas_id: item.plano_contas_id ? (pcMap[item.plano_contas_id] ?? null) : null,
            centro_custo_id: item.centro_custo_id ? (ccMap[item.centro_custo_id] ?? null) : null,
            forma_pagamento_id: item.forma_pagamento_id ? (fpMap[item.forma_pagamento_id] ?? null) : null,
            data_vencimento: item.data_vencimento || null,
            data_competencia: item.data_competencia || null,
            data_liquidacao: item.data_liquidacao || null,
            liquidado: item.liquidado === "1",
            status: normalizeLancamentoStatus(item),
            last_synced_at: new Date().toISOString(),
          }));

        if (finBatch.length > 0) {
          const { error: finErr } = await supabase
            .from("fin_pagamentos")
            .upsert(finBatch, { onConflict: "gc_id" });
          if (finErr) {
            console.error(`[sync-all] fin_pagamentos upsert error: ${finErr.message}`);
          } else {
            finPagUpserted += finBatch.length;
          }
        }
      }

      // Backfill recipient_document
      try {
        const { data: missing } = await supabase
          .from("fin_pagamentos")
          .select("id, fornecedor_gc_id")
          .is("recipient_document", null)
          .not("fornecedor_gc_id", "is", null)
          .limit(500);

        const updatesByDoc: Record<string, string[]> = {};
        for (const p of (missing ?? []) as any[]) {
          const doc = fornDocMap[p.fornecedor_gc_id];
          if (doc) {
            if (!updatesByDoc[doc]) updatesByDoc[doc] = [];
            updatesByDoc[doc].push(p.id);
          }
        }
        for (const [doc, ids] of Object.entries(updatesByDoc)) {
          await supabase.from("fin_pagamentos")
            .update({ recipient_document: doc })
            .in("id", ids);
        }
      } catch (e) {
        console.error("[sync-all] Backfill recipient_document error:", e);
      }

      results.pagamentos = {
        status: pagErrors > 0 ? "partial" : "ok",
        fetched: pagRecords.length,
        gc_upserted: gcPagUpserted,
        fin_upserted: finPagUpserted,
        errors: pagErrors,
        duration_ms: Date.now() - pagStart,
      };
      console.log(`[sync-all] Pagamentos done: ${pagRecords.length} fetched, gc=${gcPagUpserted}, fin=${finPagUpserted} (${Date.now() - pagStart}ms)`);
    } catch (err) {
      results.pagamentos = { status: "error", error: (err as Error).message, duration_ms: Date.now() - pagStart };
      console.error(`[sync-all] pagamentos error: ${(err as Error).message}`);
    }

    // ── Log final ──
    const totalDuration = Date.now() - startTime;
    const hasErrors = Object.values(results).some((r: any) => r.status === "error");

    await supabase.from("fin_sync_log").insert({
      tipo: "sync-all",
      status: hasErrors ? "partial" : "success",
      payload: results,
      duracao_ms: totalDuration,
    });

    console.log(`[sync-all] ✅ Complete in ${totalDuration}ms — 6 modules consolidated`);

    return new Response(JSON.stringify({ success: true, results, duration_ms: totalDuration }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = (error as Error).message;
    console.error("[sync-all] Fatal error:", errorMsg);

    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await supabase.from("fin_sync_log").insert({
        tipo: "sync-all",
        status: "erro",
        erro: errorMsg,
        duracao_ms: duration,
      });
    } catch { /* ignore */ }

    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
