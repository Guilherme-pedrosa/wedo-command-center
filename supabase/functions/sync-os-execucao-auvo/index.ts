// sync-os-execucao-auvo
// Importação dedicada e SOMENTE-LEITURA nos sistemas de origem (GestãoClick + Auvo):
// descobre a tarefa de EXECUÇÃO (atributo GC 73344) de cada OS e confirma a execução real
// pelo CHECKOUT da tarefa no Auvo. Atualiza apenas os campos locais de verificação de
// os_index. Não toca em financeiro, não faz baixa, não executa PUT/POST nas origens.
import { installGcUsuarioId } from "../_shared/gc-user.ts";
installGcUsuarioId();

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";
const AUVO_BASE = "https://api.auvo.com.br/v2";
const LOCK_NAME = "sync-os-execucao-auvo";
const ATTR_TAREFA_EXECUCAO = "73344"; // TAREFA EXECUÇÃO (73343 = TAREFA OS, não serve como prova)
const TIME_BUDGET_MS = 100_000;
const MIN_DELAY_MS = 350;

export type VerifStatus =
  | "confirmado_checkout"
  | "nao_finalizado"
  | "sem_vinculo"
  | "tarefa_nao_encontrada"
  | "erro";

let lastCallTime = 0;
async function paced(url: string, options: RequestInit): Promise<Response> {
  const elapsed = Date.now() - lastCallTime;
  if (elapsed < MIN_DELAY_MS) await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  lastCallTime = Date.now();
  return fetch(url, options);
}

// ─── Regras puras (testadas em src/test/os-execucao-auvo.test.ts) ─────────────
export const soData = (v: unknown): string | null => {
  const m = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const br = String(v ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
};

export function extrairTarefasExecucao(atributos: unknown): string[] {
  if (!Array.isArray(atributos)) return [];
  const ids: string[] = [];
  for (const raw of atributos) {
    const a = (raw as { atributo?: Record<string, unknown> })?.atributo;
    if (!a) continue;
    if (String(a.atributo_id ?? "") !== ATTR_TAREFA_EXECUCAO) continue;
    for (const part of String(a.conteudo ?? "").split(/[^0-9]+/)) {
      if (part && !ids.includes(part)) ids.push(part);
    }
  }
  return ids;
}

// Auvo devolve nomes diferentes conforme versão; checkout é a ÚNICA prova de execução.
export function lerCheckout(task: Record<string, unknown> | null | undefined): string | null {
  if (!task) return null;
  for (const k of ["checkOutDate", "checkoutDate", "checkOut", "dateCheckOut", "checkOutDateTime"]) {
    const d = soData((task as Record<string, unknown>)[k]);
    // Auvo manda "0001-01-01" quando não houve checkout.
    if (d && !d.startsWith("0001-")) return d;
  }
  return null;
}

export function lerDataEstimada(task: Record<string, unknown> | null | undefined): string | null {
  if (!task) return null;
  for (const k of ["taskDate", "date", "scheduledDate", "creationDate"]) {
    const d = soData((task as Record<string, unknown>)[k]);
    if (d && !d.startsWith("0001-")) return d;
  }
  return null;
}

export type TarefaResultado =
  | { kind: "ok"; taskId: string; checkout: string | null; estimada: string | null; status?: unknown }
  | { kind: "not_found"; taskId: string }
  | { kind: "error"; taskId: string; motivo: string };

/**
 * Decisão conservadora:
 * - qualquer erro de rede/429/5xx => "erro" (preserva o que já existia; nunca destrói confirmação);
 * - sem vínculo => "sem_vinculo";
 * - com checkout => confirma pela data de checkout MAIS RECENTE (evento reaberto);
 * - tarefas encontradas sem checkout => "nao_finalizado" (data agendada NÃO prova execução);
 * - todas as tarefas 404 => "tarefa_nao_encontrada".
 */
export function decidirExecucao(
  taskIds: string[],
  resultados: TarefaResultado[],
): { status: VerifStatus; data_execucao_real: string | null; data_execucao_estimada: string | null; motivo: string } {
  if (taskIds.length === 0) {
    return { status: "sem_vinculo", data_execucao_real: null, data_execucao_estimada: null, motivo: "OS sem atributo TAREFA EXECUÇÃO (73344)" };
  }
  const erros = resultados.filter((r) => r.kind === "error") as Extract<TarefaResultado, { kind: "error" }>[];
  const oks = resultados.filter((r) => r.kind === "ok") as Extract<TarefaResultado, { kind: "ok" }>[];
  const checkouts = oks.map((r) => r.checkout).filter((d): d is string => !!d).sort();
  if (checkouts.length > 0) {
    const escolhida = checkouts[checkouts.length - 1];
    const motivo = checkouts.length > 1
      ? `checkout confirmado em ${checkouts.length} tarefas; usada a mais recente (${escolhida})`
      : `checkout Auvo em ${escolhida}`;
    return { status: "confirmado_checkout", data_execucao_real: escolhida, data_execucao_estimada: null, motivo };
  }
  if (erros.length > 0) {
    return {
      status: "erro",
      data_execucao_real: null,
      data_execucao_estimada: null,
      motivo: `falha ao consultar Auvo (dado anterior preservado): ${erros.map((e) => `${e.taskId}:${e.motivo}`).join(", ")}`,
    };
  }
  if (oks.length > 0) {
    const estimada = oks.map((r) => r.estimada).filter((d): d is string => !!d).sort().pop() ?? null;
    return {
      status: "nao_finalizado",
      data_execucao_real: null,
      data_execucao_estimada: estimada,
      motivo: "tarefa Auvo encontrada sem checkout (não finalizada / com pendência)",
    };
  }
  return {
    status: "tarefa_nao_encontrada",
    data_execucao_real: null,
    data_execucao_estimada: null,
    motivo: `tarefa(s) ${taskIds.join(",")} não existem mais no Auvo`,
  };
}

// ─── Runtime ────────────────────────────────────────────────────────────────
async function auvoLogin(): Promise<string> {
  const apiKey = Deno.env.get("AUVO_API_KEY");
  const apiToken = Deno.env.get("AUVO_USER_TOKEN");
  if (!apiKey || !apiToken) throw new Error("AUVO credentials not configured");
  const res = await fetch(`${AUVO_BASE}/login/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, apiToken }),
  });
  if (!res.ok) throw new Error(`Auvo login failed: ${res.status}`);
  const json = await res.json();
  const token = json?.result?.accessToken ?? json?.result?.token ?? json?.token;
  if (!token) throw new Error("Auvo login: accessToken not found");
  return token as string;
}

async function buscarTarefa(token: string, taskId: string): Promise<TarefaResultado> {
  try {
    const res = await paced(`${AUVO_BASE}/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (res.status === 404) return { kind: "not_found", taskId };
    if (!res.ok) return { kind: "error", taskId, motivo: `HTTP ${res.status}` };
    const json = await res.json();
    const task = (json?.result ?? json?.data ?? json) as Record<string, unknown>;
    return { kind: "ok", taskId, checkout: lerCheckout(task), estimada: lerDataEstimada(task), status: task?.taskStatus };
  } catch (e) {
    return { kind: "error", taskId, motivo: (e as Error).message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const t0 = Date.now();
  const runId = crypto.randomUUID();
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const gcHeaders = {
    "access-token": Deno.env.get("GC_ACCESS_TOKEN") ?? "",
    "secret-access-token": Deno.env.get("GC_SECRET_TOKEN") ?? "",
    "Content-Type": "application/json",
  };

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const dryRun = body?.dry_run !== false && body?.dry_run !== 0 ? body?.dry_run === true : false;
  const dateFrom = String(body?.date_from ?? "2026-01-01");
  const dateTo = String(body?.date_to ?? "2026-12-31");
  const batchLimit = Math.min(Number(body?.limit) || 120, 400);
  const force = body?.force === true;
  const staleHours = Number(body?.stale_hours) || 24 * 14;
  const osIds: string[] | null = Array.isArray(body?.os_ids) ? (body!.os_ids as string[]).map(String) : null;

  // ── Lock com heartbeat/prazo: execução abandonada expira e não bloqueia para sempre ──
  const nowIso = new Date().toISOString();
  const { data: lock } = await supabase.from("fin_job_locks").select("*").eq("nome", LOCK_NAME).maybeSingle();
  if (lock && lock.status === "running" && new Date(lock.expires_at).getTime() > Date.now()) {
    return new Response(JSON.stringify({ ok: false, status: "locked", run_id: lock.run_id, heartbeat_at: lock.heartbeat_at }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  await supabase.from("fin_job_locks").upsert({
    nome: LOCK_NAME, run_id: runId, status: "running", locked_at: nowIso, heartbeat_at: nowIso,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    payload: { date_from: dateFrom, date_to: dateTo, dry_run: dryRun, limit: batchLimit },
  }, { onConflict: "nome" });

  const contagem: Record<string, number> = {};
  const pendentes: { os_codigo: string; status: string; motivo: string }[] = [];
  const evidencias: Record<string, unknown>[] = [];
  let processadas = 0;
  let atualizadas = 0;
  let finalStatus = "ok";
  let erroFatal: string | null = null;

  try {
    // Seleção incremental: não reprocessa toda a história a cada chamada.
    let q = supabase
      .from("os_index")
      .select("os_id, os_codigo, data_saida, nome_situacao, data_execucao_real, data_execucao_origem, auvo_task_ids, execucao_verificacao_status, execucao_verificado_em")
      .like("nome_situacao", "EXECUTADO%")
      .order("os_id", { ascending: true })
      .limit(batchLimit);
    if (osIds) {
      q = q.in("os_id", osIds);
    } else {
      q = q.gte("data_saida", dateFrom).lte("data_saida", dateTo);
      if (!force) {
        const corte = new Date(Date.now() - staleHours * 3600_000).toISOString();
        // Nunca reconsulta o que já está confirmado; revisita o resto quando envelhece.
        q = q.or(`execucao_verificado_em.is.null,and(execucao_verificado_em.lt.${corte},execucao_verificacao_status.neq.confirmado_checkout)`);
      }
    }
    const { data: candidatas, error: selErr } = await q;
    if (selErr) throw selErr;

    const alvos = (candidatas ?? []) as Record<string, any>[];
    const token = alvos.length > 0 ? await auvoLogin() : "";

    for (const os of alvos) {
      if (Date.now() - t0 > TIME_BUDGET_MS) { finalStatus = "partial"; break; }
      processadas++;

      // 1) GC (GET, somente leitura) para achar a tarefa de execução
      let taskIds: string[] = [];
      let gcErro: string | null = null;
      try {
        const res = await paced(`${GC_BASE_URL}/api/ordens_servicos/${os.os_id}?usuario_id=1320473`, { headers: gcHeaders });
        if (!res.ok) gcErro = `GC HTTP ${res.status}`;
        else {
          const json = await res.json();
          taskIds = extrairTarefasExecucao(json?.data?.atributos);
        }
      } catch (e) { gcErro = (e as Error).message; }

      let decisao: ReturnType<typeof decidirExecucao>;
      let resultados: TarefaResultado[] = [];
      if (gcErro) {
        decisao = { status: "erro", data_execucao_real: null, data_execucao_estimada: null, motivo: `falha ao ler OS no GC (dado anterior preservado): ${gcErro}` };
      } else {
        resultados = [];
        for (const tid of taskIds) resultados.push(await buscarTarefa(token, tid));
        decisao = decidirExecucao(taskIds, resultados);
      }

      contagem[decisao.status] = (contagem[decisao.status] || 0) + 1;
      if (decisao.status !== "confirmado_checkout") {
        pendentes.push({ os_codigo: String(os.os_codigo), status: decisao.status, motivo: decisao.motivo });
      }

      const antes = { data_execucao_real: os.data_execucao_real ?? null, origem: os.data_execucao_origem ?? null };
      // Preservação: erro nunca zera confirmação anterior.
      const preservar = decisao.status === "erro" || decisao.status === "tarefa_nao_encontrada";
      const novaData = decisao.data_execucao_real ?? (preservar ? antes.data_execucao_real : null);
      const novaOrigem = decisao.data_execucao_real
        ? "auvo_check_out"
        : (preservar ? antes.origem : null);

      if (evidencias.length < 25) {
        evidencias.push({
          os_codigo: os.os_codigo, os_id: os.os_id, task_ids: taskIds, status: decisao.status,
          antes, depois: { data_execucao_real: novaData, origem: novaOrigem }, motivo: decisao.motivo,
          auvo: resultados.map((r) => ({ ...r })),
        });
      }

      if (!dryRun) {
        const patch: Record<string, unknown> = {
          auvo_task_ids: taskIds.length ? taskIds : null,
          auvo_task_id: taskIds[0] ?? os.auvo_task_id ?? null,
          execucao_verificacao_status: decisao.status,
          execucao_verificacao_motivo: decisao.motivo,
          execucao_verificado_em: new Date().toISOString(),
          data_execucao_estimada: decisao.data_execucao_estimada,
          data_execucao_sincronizada_em: new Date().toISOString(),
        };
        if (novaData !== antes.data_execucao_real) {
          patch.data_execucao_anterior = antes.data_execucao_real;
        }
        patch.data_execucao_real = novaData;
        patch.data_execucao_origem = novaOrigem;
        const { error: upErr } = await supabase.from("os_index").update(patch).eq("os_id", os.os_id);
        if (upErr) { finalStatus = "partial"; console.error(`[exec-auvo] update ${os.os_codigo}: ${upErr.message}`); }
        else atualizadas++;
      }

      await supabase.from("fin_os_execucao_log").insert({
        run_id: runId, os_id: String(os.os_id), os_codigo: String(os.os_codigo ?? ""),
        auvo_task_ids: taskIds.length ? taskIds : null, status: decisao.status, motivo: decisao.motivo,
        data_execucao_antes: antes.data_execucao_real, data_execucao_depois: novaData,
        origem_antes: antes.origem, origem_depois: novaOrigem, dry_run: dryRun,
        evidencia: { task_results: resultados, gc_erro: gcErro },
      });

      if (processadas % 20 === 0) {
        await supabase.from("fin_job_locks").update({
          heartbeat_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
          cursor_value: String(os.os_id),
        }).eq("nome", LOCK_NAME);
      }
    }

    if (alvos.length === batchLimit) finalStatus = finalStatus === "ok" ? "partial" : finalStatus;
  } catch (e) {
    erroFatal = (e as Error).message;
    finalStatus = "erro";
  }

  await supabase.from("fin_job_locks").update({
    status: finalStatus === "erro" ? "erro" : "idle",
    heartbeat_at: new Date().toISOString(),
    expires_at: new Date().toISOString(),
    payload: { run_id: runId, status: finalStatus, processadas, atualizadas, contagem, erro: erroFatal },
  }).eq("nome", LOCK_NAME);

  await supabase.from("sync_log").insert({
    tipo: "sync-os-execucao-auvo",
    status: finalStatus,
    erro: erroFatal,
    payload: { run_id: runId, dry_run: dryRun, date_from: dateFrom, date_to: dateTo, processadas, atualizadas, contagem, pendentes: pendentes.slice(0, 50) },
    duracao_ms: Date.now() - t0,
  });

  return new Response(JSON.stringify({
    ok: !erroFatal, run_id: runId, status: finalStatus, dry_run: dryRun,
    processadas, atualizadas, contagem, pendentes: pendentes.slice(0, 60), evidencias,
    erro: erroFatal, duration_ms: Date.now() - t0,
  }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
