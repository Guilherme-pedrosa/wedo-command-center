import { supabase } from "@/integrations/supabase/client";

interface GCProxyRequest {
  endpoint: string;
  method?: string;
  payload?: Record<string, unknown>;
  params?: Record<string, string>;
}

interface GCProxyResponse<T = unknown> {
  status: number;
  data: T;
  duration_ms: number;
  _gc_calls_today?: number;
}

// GC API wraps responses in { code, data, meta, status }
interface GCApiResponse<T> {
  code: number;
  data: T[];
  meta: {
    limite_por_pagina: number;
    pagina_atual: number;
    total_paginas: number;
    total_registros: number;
    total_registros_pagina: number;
  };
  status: string;
}

// ── Cooldown entre syncs manuais (por tipo) ──
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos
const lastSyncTimes = new Map<string, number>();

export function checkSyncCooldown(syncType: string): { allowed: boolean; remainingSeconds: number } {
  const lastTime = lastSyncTimes.get(syncType) || 0;
  const elapsed = Date.now() - lastTime;
  if (elapsed < COOLDOWN_MS) {
    return { allowed: false, remainingSeconds: Math.ceil((COOLDOWN_MS - elapsed) / 1000) };
  }
  return { allowed: true, remainingSeconds: 0 };
}

export function markSyncStarted(syncType: string) {
  lastSyncTimes.set(syncType, Date.now());
}

export async function callGC<T = unknown>(request: GCProxyRequest): Promise<GCProxyResponse<T>> {
  const { data, error } = await supabase.functions.invoke("gc-proxy", {
    body: request,
  });

  if (error) {
    // Check if it's a rate limit error from our proxy
    if (error.message?.includes("DAILY_LIMIT_EXCEEDED") || error.message?.includes("Limite diário")) {
      throw new Error("Limite diário de chamadas à API do GestãoClick atingido. Tente novamente amanhã.");
    }
    throw new Error(error.message);
  }
  
  // Check for 429 from our proxy (daily limit)
  if (data?.code === "DAILY_LIMIT_EXCEEDED") {
    throw new Error(data.error || "Limite diário de chamadas à API atingido.");
  }

  return data as GCProxyResponse<T>;
}

// Paginated fetch helper — fetches ALL pages from GC
export async function fetchAllGCPages<T>(
  endpoint: string,
  onProgress?: (current: number, total: number) => void
): Promise<T[]> {
  const allRecords: T[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    let res: GCProxyResponse<GCApiResponse<T>>;
    try {
      res = await callGC<GCApiResponse<T>>({
        endpoint,
        params: { limite: "100", pagina: String(page) },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Limite diário: para a paginação sem quebrar a tela
      if (
        msg.includes("DAILY_LIMIT_EXCEEDED") ||
        msg.includes("Limite diário") ||
        msg.includes("Edge function returned 429")
      ) {
        break;
      }
      throw err;
    }

    if (res.status === 401) throw new Error("GC_AUTH_ERROR");
    if (res.status === 429) {
      // Check if it's our daily limit
      const resData = res.data as any;
      if (resData?.code === "DAILY_LIMIT_EXCEEDED") {
        throw new Error(resData.error || "Limite diário de chamadas à API atingido.");
      }
      await new Promise((r) => setTimeout(r, 2000));
      continue; // retry same page
    }
    if (res.status >= 500) throw new Error(`GC server error: ${res.status}`);

    const gcResponse = res.data;
    if (gcResponse?.data) {
      allRecords.push(...gcResponse.data);
      totalPages = gcResponse.meta?.total_paginas || 1;
      onProgress?.(page, totalPages);
    }

    page++;
  }

  return allRecords;
}

// Test GC connection — fetches 1 receivable
export async function testGCConnection(): Promise<{ ok: boolean; total: number; message: string }> {
  try {
    const res = await callGC<GCApiResponse<unknown>>({
      endpoint: "/api/recebimentos",
      params: { limite: "1", pagina: "1" },
    });

    if (res.status === 401) {
      return { ok: false, total: 0, message: "Credenciais inválidas (HTTP 401)" };
    }
    if (res.status !== 200) {
      return { ok: false, total: 0, message: `Erro HTTP ${res.status}` };
    }

    const total = res.data?.meta?.total_registros || 0;
    const callsToday = (res as any)._gc_calls_today || "?";
    return { ok: true, total, message: `Conectado — ${total} recebimentos (${res.duration_ms}ms) | Chamadas hoje: ${callsToday}/2000` };
  } catch (err: unknown) {
    return { ok: false, total: 0, message: `Erro: ${err instanceof Error ? err.message : String(err)}` };
  }
}
