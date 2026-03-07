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
}

export async function callGC<T = unknown>(request: GCProxyRequest): Promise<GCProxyResponse<T>> {
  const { data, error } = await supabase.functions.invoke("gc-proxy", {
    body: request,
  });

  if (error) throw new Error(error.message);
  return data as GCProxyResponse<T>;
}

// Paginated fetch helper — fetches ALL pages
export async function fetchAllGCPages<T>(
  endpoint: string,
  onProgress?: (current: number, total: number) => void
): Promise<T[]> {
  const allRecords: T[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const res = await callGC<{
      data?: T[];
      pagina_atual?: number;
      total_paginas?: number;
      total_registros?: number;
    }>({
      endpoint,
      params: { limite: "100", pagina: String(page) },
    });

    if (res.status === 401) throw new Error("GC_AUTH_ERROR");
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      continue; // retry same page
    }
    if (res.status >= 500) throw new Error(`GC server error: ${res.status}`);

    const body = res.data;
    if (body && typeof body === "object" && "data" in body) {
      const gcBody = body as { data: T[]; total_paginas: number; pagina_atual: number };
      allRecords.push(...(gcBody.data || []));
      totalPages = gcBody.total_paginas || 1;
      onProgress?.(page, totalPages);
    }

    page++;
  }

  return allRecords;
}
