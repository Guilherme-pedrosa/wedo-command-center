// Sincroniza a data REAL de execução de cada OS a partir do Auvo (checkOutDate
// do técnico). Lê os auvo_task_id do atributo 73343 ("Tarefa OS") no GC.
// Prioridade: checkOutDate > dateConclusion > taskDate.
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GC_BASE = "https://api.gestaoclick.com";
const AUVO_BASE = "https://api.auvo.com.br/v2";
const ATRIBUTO_TAREFA_OS = "73343";

function dataValida(raw: unknown): string | null {
  const m = String(raw ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const v = m[1];
  if (v === "0001-01-01" || v === "1900-01-01") return null;
  return v;
}

function dataDeRawAuvo(raw: any): { data: string | null; origem: string } {
  const checkOut = dataValida(raw?.checkOutDate || raw?.checkoutDate || raw?.dateCheckOut);
  if (checkOut) return { data: checkOut, origem: "auvo_check_out" };
  const conclusao = dataValida(raw?.dateConclusion || raw?.finishDate || raw?.dateConclude);
  if (conclusao) return { data: conclusao, origem: "auvo_conclusao" };
  const taskDate = dataValida(raw?.taskDate || raw?.date);
  if (taskDate) return { data: taskDate, origem: "auvo_data_tarefa" };
  return { data: null, origem: "sem_data" };
}

function extrairAuvoTaskId(osObj: any): string | null {
  const atributos: any[] = Array.isArray(osObj?.atributos) ? osObj.atributos : [];
  for (const a of atributos) {
    const nested = a?.atributo || a;
    const id = String(nested?.atributo_id || nested?.id || "");
    const label = String(nested?.descricao || nested?.label || nested?.nome || "").toLowerCase();
    if (id === ATRIBUTO_TAREFA_OS || label.includes("tarefa os")) {
      const valor = String(nested?.conteudo || nested?.valor || "").trim();
      if (!valor) return null;
      // Pode vir "12345" ou "12345/67890" (múltiplos). Pega o primeiro número.
      const m = valor.split("/").map((s) => s.trim()).find((s) => /^\d+$/.test(s));
      return m || null;
    }
  }
  return null;
}

async function auvoLogin(apiKey: string, apiToken: string): Promise<string> {
  const res = await fetch(`${AUVO_BASE}/login/?apiKey=${encodeURIComponent(apiKey)}&apiToken=${encodeURIComponent(apiToken)}`);
  if (!res.ok) {
    // Fallback POST
    const res2 = await fetch(`${AUVO_BASE}/login/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, apiToken }),
    });
    if (!res2.ok) throw new Error(`Auvo login failed: ${res2.status}`);
    const j2 = await res2.json();
    const t2 = j2?.result?.accessToken ?? j2?.result?.token ?? j2?.token;
    if (!t2) throw new Error("Auvo login: token ausente");
    return t2;
  }
  const j = await res.json();
  const t = j?.result?.accessToken ?? j?.result?.token ?? j?.token;
  if (!t) throw new Error("Auvo login: token ausente");
  return t;
}

async function fetchAuvoTask(token: string, taskId: string): Promise<any | null> {
  const url = `${AUVO_BASE}/tasks/${encodeURIComponent(taskId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.warn(`[sync-os-data-execucao] Auvo task ${taskId} → ${res.status}`);
    return null;
  }
  const j = await res.json();
  return j?.result?.entity ?? j?.result ?? j ?? null;
}

async function fetchGcOs(gcHeaders: Record<string, string>, osId: string): Promise<any | null> {
  const url = `${GC_BASE}/api/ordens_servicos/${encodeURIComponent(osId)}`;
  const res = await fetch(url, { headers: gcHeaders });
  if (!res.ok) {
    console.warn(`[sync-os-data-execucao] GC OS ${osId} → ${res.status}`);
    return null;
  }
  const j = await res.json();
  // GC retorna { data: { ... } } para fetch individual
  return j?.data ?? j ?? null;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  try {
    const url = new URL(req.url);
    const osCodigoParam = url.searchParams.get("os_codigo");
    const diasParam = Number(url.searchParams.get("dias") || "120");
    const limiteParam = Number(url.searchParams.get("limite") || "0"); // 0 = sem limite
    const forceParam = url.searchParams.get("force") === "1";

    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");
    const auvoKey = Deno.env.get("AUVO_API_KEY");
    const auvoToken = Deno.env.get("AUVO_USER_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!gcAccessToken || !gcSecretToken) {
      return new Response(JSON.stringify({ error: "GC credentials not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!auvoKey || !auvoToken) {
      return new Response(JSON.stringify({ error: "AUVO credentials not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const gcHeaders: Record<string, string> = {
      "access-token": gcAccessToken,
      "secret-access-token": gcSecretToken,
      "Content-Type": "application/json",
    };

    // ---- Seleciona OS-alvo
    let q = supabase
      .from("os_index")
      .select("id, os_id, os_codigo, nome_situacao, data_saida, data_execucao_real, data_execucao_sincronizada_em")
      .ilike("nome_situacao", "EXECUTADO%");

    if (osCodigoParam) {
      q = q.eq("os_codigo", osCodigoParam);
    } else {
      const cutoff = new Date(Date.now() - diasParam * 24 * 3600 * 1000);
      q = q.gte("data_saida", cutoff.toISOString().slice(0, 10));
      if (!forceParam) {
        // Reprocessa apenas as que nunca foram sincronizadas ou cuja última sync foi há +24h
        const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        q = q.or(`data_execucao_sincronizada_em.is.null,data_execucao_sincronizada_em.lt.${yesterday}`);
      }
    }

    if (limiteParam > 0) q = q.limit(limiteParam);
    else q = q.limit(500); // safety cap por execução

    const { data: alvos, error: qerr } = await q;
    if (qerr) throw qerr;
    if (!alvos || alvos.length === 0) {
      return new Response(JSON.stringify({ ok: true, processadas: 0, msg: "Nada a fazer" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[sync-os-data-execucao] alvos=${alvos.length} osCodigo=${osCodigoParam ?? "-"} dias=${diasParam}`);

    // ---- Login Auvo (1x)
    const auvoBearer = await auvoLogin(auvoKey, auvoToken);

    // ---- Loop processamento (sequencial leve, com pequeno delay)
    let processadas = 0;
    let atualizadas = 0;
    let semAtributo = 0;
    let semTaskAuvo = 0;
    let semData = 0;
    const amostra: any[] = [];

    async function processOne(row: any) {
      try {
        const osGc = await fetchGcOs(gcHeaders, String(row.os_id));
        if (!osGc) return;
        const auvoTaskId = extrairAuvoTaskId(osGc);
        if (!auvoTaskId) {
          semAtributo++;
          await supabase.from("os_index").update({
            data_execucao_origem: "sem_atributo_auvo",
            data_execucao_sincronizada_em: new Date().toISOString(),
          }).eq("id", row.id);
          return;
        }
        const task = await fetchAuvoTask(auvoBearer, auvoTaskId);
        if (!task) {
          semTaskAuvo++;
          await supabase.from("os_index").update({
            auvo_task_id: auvoTaskId,
            data_execucao_origem: "task_auvo_nao_encontrada",
            data_execucao_sincronizada_em: new Date().toISOString(),
          }).eq("id", row.id);
          return;
        }
        const { data: dataExec, origem } = dataDeRawAuvo(task);
        if (!dataExec) semData++;
        await supabase.from("os_index").update({
          auvo_task_id: auvoTaskId,
          data_execucao_real: dataExec,
          data_execucao_origem: origem,
          data_execucao_sincronizada_em: new Date().toISOString(),
        }).eq("id", row.id);
        if (dataExec) atualizadas++;
        if (amostra.length < 10) {
          amostra.push({ os: row.os_codigo, task: auvoTaskId, data: dataExec, origem });
        }
      } catch (e) {
        console.error(`[sync-os-data-execucao] OS ${row.os_codigo} erro:`, e instanceof Error ? e.message : e);
      }
    }

    // Pool de 8 workers paralelos
    const POOL = 8;
    let cursor = 0;
    const workers = Array.from({ length: POOL }, async () => {
      while (cursor < alvos.length) {
        const idx = cursor++;
        processadas++;
        await processOne(alvos[idx]);
      }
    });
    await Promise.all(workers);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    return new Response(JSON.stringify({
      ok: true,
      processadas,
      atualizadas,
      sem_atributo: semAtributo,
      sem_task_auvo: semTaskAuvo,
      sem_data: semData,
      elapsed_s: Number(elapsed),
      amostra,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[sync-os-data-execucao] erro fatal:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
