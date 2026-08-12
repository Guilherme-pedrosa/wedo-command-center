import { installGcUsuarioId } from "../_shared/gc-user.ts";
installGcUsuarioId();

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { z } from "npm:zod@3.23.8";

const GC_BASE_URL = "https://api.gestaoclick.com";
const MIN_DELAY_MS = 350;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

let lastCallTime = 0;

const BodySchema = z.object({
  forma_pagamento_ids: z.array(z.string().uuid()).min(1),
  data_vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

type FinLancamentoStatus = "pendente" | "pago" | "vencido" | "cancelado";

function parseNumber(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return 0;
  const s = String(raw).trim();
  const normalized = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

function isLiquidadoGC(value: unknown): boolean {
  const normalized = String(value ?? "").toLowerCase().trim();
  return value === true || value === 1 || normalized === "1" || normalized === "pg" || normalized === "pago" || normalized === "liquidado" || normalized === "baixado";
}

function coerceStatus(value: unknown, fallback: FinLancamentoStatus = "pendente"): FinLancamentoStatus {
  const normalized = String(value ?? "").toLowerCase().trim();
  if (["liquidado", "pago", "paga", "baixado", "recebido", "quitado"].includes(normalized)) return "pago";
  if (["cancelado", "cancelada", "cancelar"].includes(normalized)) return "cancelado";
  if (normalized === "vencido") return "vencido";
  if (normalized === "pendente") return "pendente";
  return fallback;
}

function normalizeStatus(item: Record<string, unknown>): FinLancamentoStatus {
  if (isLiquidadoGC(item.liquidado)) return "pago";
  const rawStatus = item.status ?? item.situacao ?? item.nome_situacao ?? item.status_pagamento;
  const coerced = coerceStatus(rawStatus);
  if (coerced !== "pendente" || String(rawStatus ?? "").toLowerCase().trim() === "pendente") return coerced;

  const dataVencimento = item.data_vencimento ? new Date(String(item.data_vencimento)) : null;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  if (dataVencimento && !Number.isNaN(dataVencimento.getTime())) {
    dataVencimento.setHours(0, 0, 0, 0);
    if (dataVencimento < hoje) return "vencido";
  }
  return "pendente";
}

function extrairOsCodigo(descricao: unknown): string | null {
  if (!descricao) return null;
  const match = String(descricao).match(/Ordem de serviço de nº\s*(\d+)/i);
  return match?.[1] ?? null;
}

function inferirTipo(descricao: unknown): "os" | "venda" | "contrato" | "outro" {
  const d = String(descricao ?? "");
  if (/ordem de serviço/i.test(d)) return "os";
  if (/venda/i.test(d)) return "venda";
  if (/contrato/i.test(d)) return "contrato";
  return "outro";
}

function inferirOrigem(descricao: unknown): "gc_os" | "gc_venda" | "gc_contrato" | "outro" {
  const d = String(descricao ?? "");
  if (/ordem de serviço/i.test(d)) return "gc_os";
  if (/\bvenda\b/i.test(d)) return "gc_venda";
  if (/contrato/i.test(d)) return "gc_contrato";
  return "outro";
}

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_DELAY_MS) await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  lastCallTime = Date.now();
  return fetch(url, options);
}

async function fetchGCPagamentos(headers: Record<string, string>, dataVencimento: string) {
  const allRecords: any[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= MAX_PAGES) {
    const params = new URLSearchParams({
      limite: String(PAGE_SIZE),
      pagina: String(page),
      data_inicio: dataVencimento,
      data_fim: dataVencimento,
    });
    const url = `${GC_BASE_URL}/api/pagamentos?${params.toString()}`;
    const response = await rateLimitedFetch(url, { headers });

    if (response.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const text = await response.text();
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }

    if (!response.ok) {
      console.error(`[sync-fatura-cartao-pagamentos] GC error [${response.status}]: ${text}`);
      throw new Error(`Gestão Click retornou HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const records = Array.isArray(payload?.data) ? payload.data : [];
    allRecords.push(...records);
    totalPages = Number(payload?.meta?.total_paginas || 1);
    page += 1;
  }

  return allRecords;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");

    if (!supabaseUrl || !anonKey || !serviceKey) {
      return new Response(JSON.stringify({ error: "Backend não configurado" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!gcAccessToken || !gcSecretToken) {
      return new Response(JSON.stringify({ error: "Credenciais do Gestão Click não configuradas" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await callerClient.auth.getUser();
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: "Usuário não autenticado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error.flatten().fieldErrors }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { forma_pagamento_ids, data_vencimento } = parsed.data;
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: formas, error: formasError } = await admin
      .from("fin_formas_pagamento")
      .select("id,gc_id,nome")
      .in("id", forma_pagamento_ids);
    if (formasError) throw formasError;

    const selectedGcIds = new Set((formas ?? []).map((f: any) => String(f.gc_id || "").trim()).filter(Boolean));
    const fpMap: Record<string, string> = {};
    for (const f of formas ?? []) {
      if ((f as any).gc_id) fpMap[String((f as any).gc_id)] = String((f as any).id);
    }

    if (selectedGcIds.size === 0) {
      return new Response(JSON.stringify({
        success: true,
        total_gc_fetched: 0,
        matched: 0,
        upserted: 0,
        pagamentos: [],
        warning: "As formas selecionadas não têm código do Gestão Click vinculado.",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const [{ data: planos }, { data: centros }, gcRecords] = await Promise.all([
      admin.from("fin_plano_contas").select("id,gc_id").not("gc_id", "is", null),
      admin.from("fin_centros_custo").select("id,gc_id").not("gc_id", "is", null),
      fetchGCPagamentos({
        "access-token": gcAccessToken,
        "secret-access-token": gcSecretToken,
        "Content-Type": "application/json",
      }, data_vencimento),
    ]);

    const pcMap: Record<string, string> = {};
    for (const p of planos ?? []) pcMap[String((p as any).gc_id)] = String((p as any).id);
    const ccMap: Record<string, string> = {};
    for (const c of centros ?? []) ccMap[String((c as any).gc_id)] = String((c as any).id);

    const matched = gcRecords
      .map((raw: any) => raw?.Pagamento ?? raw)
      .filter((raw: any) => {
        const formaGcId = String(raw?.forma_pagamento_id ?? "").trim();
        const vencimento = String(raw?.data_vencimento ?? "").slice(0, 10);
        const status = normalizeStatus(raw ?? {});
        return selectedGcIds.has(formaGcId) && vencimento === data_vencimento && status !== "cancelado";
      });

    const rows = matched.map((raw: any) => {
      const formaGcId = String(raw.forma_pagamento_id ?? "").trim();
      const descricao = raw.descricao ?? "Sem descrição";
      return {
        gc_id: String(raw.id),
        gc_codigo: raw.codigo ? String(raw.codigo) : null,
        gc_payload_raw: raw,
        descricao,
        os_codigo: extrairOsCodigo(descricao),
        tipo: inferirTipo(descricao),
        origem: inferirOrigem(descricao),
        valor: parseNumber(raw.valor_total ?? raw.valor),
        fornecedor_gc_id: raw.fornecedor_id ? String(raw.fornecedor_id) : null,
        nome_fornecedor: raw.nome_fornecedor ?? null,
        plano_contas_id: raw.plano_contas_id ? (pcMap[String(raw.plano_contas_id)] ?? null) : null,
        centro_custo_id: raw.centro_custo_id ? (ccMap[String(raw.centro_custo_id)] ?? null) : null,
        forma_pagamento_id: fpMap[formaGcId] ?? null,
        data_vencimento: raw.data_vencimento || null,
        data_competencia: raw.data_competencia || null,
        data_liquidacao: raw.data_liquidacao || null,
        liquidado: isLiquidadoGC(raw.liquidado),
        status: normalizeStatus(raw),
        last_synced_at: new Date().toISOString(),
      };
    });

    const upsertedRows: any[] = [];
    for (let i = 0; i < rows.length; i += 50) {
      const { data, error } = await admin
        .from("fin_pagamentos")
        .upsert(rows.slice(i, i + 50), { onConflict: "gc_id" })
        .select("id,descricao,valor,data_vencimento,data_competencia,nome_fornecedor,status,forma_pagamento_id,gc_id,gc_codigo");
      if (error) throw error;
      upsertedRows.push(...(data ?? []));
    }

    await admin.from("sync_log").insert({
      tipo: "gc_fatura_cartao_pagamentos",
      status: "success",
      payload: { forma_pagamento_ids, data_vencimento, total_gc_fetched: gcRecords.length, matched: matched.length },
      resposta: { upserted: upsertedRows.length },
      duracao_ms: Date.now() - startedAt,
    });

    return new Response(JSON.stringify({
      success: true,
      total_gc_fetched: gcRecords.length,
      matched: matched.length,
      upserted: upsertedRows.length,
      pagamentos: upsertedRows.sort((a, b) => String(a.data_vencimento ?? "").localeCompare(String(b.data_vencimento ?? "")) || String(a.descricao ?? "").localeCompare(String(b.descricao ?? ""))),
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[sync-fatura-cartao-pagamentos] Fatal error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
