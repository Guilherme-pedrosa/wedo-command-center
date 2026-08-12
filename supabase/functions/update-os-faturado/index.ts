// Atualiza apenas a situação de OS no GC: 8889036 (EXECUTADO - FECHADO CHAMADO)
// → 9203836 (CHAMADO FECHADO - FATURADO). NÃO toca em financeiros (omite
// pagamentos, condicao_pagamento, forma_pagamento_id, data_primeira_parcela,
// numero_parcelas, intervalo_dias). Disparado após criação de grupo a receber.
import { installGcUsuarioId } from "../_shared/gc-user.ts";
installGcUsuarioId();

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GC_BASE_URL = "https://api.gestaoclick.com";
const SITUACAO_ORIGEM = "8889036"; // EXECUTADO - FECHADO CHAMADO
const SITUACAO_DESTINO = "9203836"; // CHAMADO FECHADO - FATURADO

const RATE_LIMIT_MS = 380;
let lastCall = 0;
async function rateLimitedFetch(url: string, options: RequestInit) {
  const wait = RATE_LIMIT_MS - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return fetch(url, options);
}

// Apenas campos que NÃO impactam financeiro (omite pagamentos/parcelas/formas).
const SAFE_PASSTHROUGH = [
  "vendedor_id", "tecnico_id", "saida", "previsao_entrega",
  "transportadora_id", "centro_custo_id", "aos_cuidados_de",
  "validade", "introducao", "observacoes", "observacoes_interna",
  "valor_frete", "equipamentos", "produtos", "servicos",
  "campos_personalizados", "campos_customizados", "campos_extras",
  "atributos",
];

const normalizeAtributos = (raw: unknown) => {
  if (!Array.isArray(raw)) return [];
  return raw.map((item: any) => {
    const a = item?.atributo ?? item ?? {};
    return {
      atributo: {
        atributo_id: String(a.atributo_id ?? a.id ?? ""),
        conteudo: a.conteudo == null ? "" : String(a.conteudo),
      },
    };
  }).filter((x: any) => x.atributo.atributo_id);
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({})) as {
      grupo_id?: string;
      os_codigos?: string[];
      os_ids?: string[];
    };

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const GC_ACCESS_TOKEN = Deno.env.get("GC_ACCESS_TOKEN");
    const GC_SECRET_TOKEN = Deno.env.get("GC_SECRET_TOKEN");
    if (!GC_ACCESS_TOKEN || !GC_SECRET_TOKEN) {
      return new Response(JSON.stringify({ error: "GC credentials missing" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const gcHeaders = {
      "Content-Type": "application/json",
      "access-token": GC_ACCESS_TOKEN,
      "secret-access-token": GC_SECRET_TOKEN,
    };

    // 1. Resolver os_ids a atualizar
    let osIds: string[] = Array.isArray(body.os_ids) ? body.os_ids.filter(Boolean).map(String) : [];

    if (body.grupo_id) {
      const { data: itens, error: errItens } = await supabase
        .from("fin_grupo_receber_itens")
        .select("os_codigo_original")
        .eq("grupo_id", body.grupo_id);
      if (errItens) throw errItens;
      const codigos = [...new Set((itens ?? [])
        .map((i: any) => i.os_codigo_original)
        .filter((c: any) => c))];
      if (codigos.length > 0) {
        const { data: osRows } = await supabase
          .from("os_index")
          .select("os_id, os_codigo")
          .in("os_codigo", codigos as string[]);
        for (const r of (osRows ?? []) as any[]) {
          if (r.os_id) osIds.push(String(r.os_id));
        }
      }
    }

    if (Array.isArray(body.os_codigos) && body.os_codigos.length > 0) {
      const { data: osRows } = await supabase
        .from("os_index")
        .select("os_id, os_codigo")
        .in("os_codigo", body.os_codigos.map(String));
      for (const r of (osRows ?? []) as any[]) {
        if (r.os_id) osIds.push(String(r.os_id));
      }
    }

    osIds = [...new Set(osIds)];

    if (osIds.length === 0) {
      return new Response(JSON.stringify({ ok: true, atualizadas: 0, skipped: 0, results: [], message: "Nenhuma OS encontrada" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const results: any[] = [];
    let atualizadas = 0;
    let skipped = 0;

    // 2. Para cada OS: GET → confere situação → PUT mínimo
    for (const osId of osIds) {
      try {
        const getResp = await rateLimitedFetch(
          `${GC_BASE_URL}/api/ordens_servicos/${osId}`,
          { method: "GET", headers: gcHeaders },
        );
        if (!getResp.ok) {
          results.push({ os_id: osId, status: "error", step: "GET", http: getResp.status });
          continue;
        }
        const getJson = await getResp.json();
        const os = (getJson?.data ?? getJson) as Record<string, any>;
        const currentSit = String(os?.situacao_id ?? "");

        if (currentSit !== SITUACAO_ORIGEM) {
          skipped++;
          results.push({ os_id: osId, status: "skipped", situacao_atual: currentSit, codigo: os?.codigo });
          continue;
        }

        const payload: Record<string, unknown> = {
          tipo: String(os.tipo ?? "servico"),
          codigo: String(os.codigo ?? ""),
          cliente_id: String(os.cliente_id ?? ""),
          data: String(os.data ?? os.data_saida ?? os.data_entrada ?? new Date().toISOString().slice(0, 10)),
          situacao_id: SITUACAO_DESTINO,
        };
        for (const key of SAFE_PASSTHROUGH) {
          const v = os[key];
          if (v === undefined || v === null) continue;
          if (key === "atributos") {
            payload.atributos = normalizeAtributos(v);
            continue;
          }
          payload[key] = v;
        }

        const doPut = async (p: Record<string, unknown>) => {
          const resp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/ordens_servicos/${osId}`,
            { method: "PUT", headers: gcHeaders, body: JSON.stringify(p) },
          );
          const text = await resp.text();
          let data: any = null;
          try { data = JSON.parse(text); } catch { /* */ }
          return { resp, text, data };
        };

        let { resp: putResp, text: putText, data: putData } = await doPut(payload);

        // Auto-recovery atributos obrigatórios (igual negotiate-os)
        const errMsg = String(putData?.data?.mensagem || putData?.message || putText || "");
        if (!putResp.ok && /atributos?\s+obrigat/i.test(errMsg)) {
          const missingIds = [...new Set([...errMsg.matchAll(/#(\d{3,})/g)].map((m) => m[1]))];
          if (missingIds.length > 0) {
            const current = Array.isArray(payload.atributos) ? [...(payload.atributos as any[])] : [];
            const presentIds = new Set(current.map((a: any) => String(a?.atributo?.atributo_id ?? "")));
            for (const id of missingIds) {
              if (!presentIds.has(id)) current.push({ atributo: { atributo_id: id, conteudo: "Faturado" } });
            }
            payload.atributos = current;
            ({ resp: putResp, text: putText, data: putData } = await doPut(payload));
          }
        }

        if (!putResp.ok) {
          results.push({
            os_id: osId, codigo: os?.codigo, status: "error", step: "PUT",
            http: putResp.status, error: errMsg.slice(0, 300),
          });
          continue;
        }

        atualizadas++;
        results.push({ os_id: osId, codigo: os?.codigo, status: "ok" });

        // Atualiza nome_situacao local em os_index (best effort)
        await supabase.from("os_index")
          .update({ nome_situacao: "CHAMADO FECHADO - FATURADO" })
          .eq("os_id", osId);
      } catch (err) {
        results.push({ os_id: osId, status: "error", error: (err as Error).message });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, total: osIds.length, atualizadas, skipped, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
