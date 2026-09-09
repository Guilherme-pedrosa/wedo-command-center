import { financialActor, financialErrorStatus } from "./financial-auth.ts";
import { executeNegotiation } from "./negotiation-execution.ts";
import { negotiationDueDates, negotiationCents } from "./negotiation-plan.ts";
import { verifyNegotiationGroup } from "./negotiation-settlement.ts";

const cors = { "X-Wedo-Negotiation-Protocol": "20260909-v2", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version" };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

export async function negotiationRequest(req: Request, deps: { supabase: any; serviceKey: string; url: string; gcHeaders: Record<string, string>; technicalUser: string; resolveOsTotal: (raw: any) => number; fetch: typeof fetch }) {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return response({ error: "Método não permitido." }, 405);
  let jobId: string | undefined;
  let executionToken: string | undefined;
  let claimed = false;
  let requestMayBePersisted = false;
  try {
    const actor = await financialActor(req, deps.supabase, deps.serviceKey);
    const body = await req.json();
    const wakeWorker = (id: string) => {
      const wake = deps.fetch(`${deps.url}/functions/v1/negotiate-os-worker`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${deps.serviceKey}` }, body: JSON.stringify({ job_id: id }) }).catch(() => undefined);
      const runtime = (globalThis as any).EdgeRuntime;
      if (runtime?.waitUntil) runtime.waitUntil(wake);
    };
    let lastCall = 0;
    const gc = async (endpoint: string, method = "GET", payload?: unknown) => {
      if (!/^\/api\/(recebimentos|ordens_servicos)(\/\d+)?(\?.*)?$/.test(endpoint)) throw new Error("Endpoint financeiro inválido.");
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 350 - (Date.now() - lastCall))));
      lastCall = Date.now();
      const result = await deps.fetch(`https://api.gestaoclick.com${endpoint}`, { method, headers: deps.gcHeaders, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      const raw = await result.text();
      let parsed: any;
      try { parsed = JSON.parse(raw); } catch { throw new Error(`GC ${method} ${endpoint.split("?")[0]}: resposta inválida (HTTP ${result.status}).`); }
      if (!result.ok || parsed.success === false || parsed.status === "error" || parsed.status === "erro" || (parsed.code != null && Number(parsed.code) >= 400) || parsed.errors) throw new Error(`GC ${method} ${endpoint.split("?")[0]} falhou (HTTP ${result.status}): ${String(parsed.message ?? parsed.data?.mensagem ?? "erro do ERP").slice(0, 300)}`);
      return parsed;
    };
    if (body.action === "verify_group") {
      const groupId = String(body.grupo_id ?? "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(groupId)) throw new Error("Grupo inválido.");
      await verifyNegotiationGroup(deps.supabase, groupId, async (id) => (await gc(`/api/recebimentos/${id}`)).data);
      return response({ success: true, integrity_verified: true, grupo_id: groupId });
    }
    if (body.action === "list") {
      const clients = new Map<string, any>();
      const seen = new Set<string>();
      const situations = body.situacao_ids?.length ? body.situacao_ids : ["7116099"];
      for (const situation of situations) {
        let pages = 1;
        for (let page = 1; page <= pages; page++) {
          if (page > 100) throw new Error("Lista de OS excedeu o limite; refine a seleção.");
          const result = await gc(`/api/ordens_servicos?${new URLSearchParams({ situacao_id: String(situation), limite: "100", pagina: String(page) })}`);
          if (!Array.isArray(result.data)) throw new Error("Lista de OS inválida.");
          pages = Number(result.meta?.total_paginas ?? 1);
          if (!Number.isInteger(pages) || pages < 1) throw new Error("Paginação de OS inválida.");
          for (const wrapper of result.data) {
            const os = wrapper.OrdemServico ?? wrapper.ordem_servico ?? wrapper;
            if (!os.id || seen.has(String(os.id))) continue;
            seen.add(String(os.id));
            const clientId = String(os.cliente_id ?? "");
            const total = negotiationCents(os.valor_total) / 100;
            if (!clientId || total <= 0) continue;
            const client = clients.get(clientId) ?? { cliente_id: clientId, nome_cliente: String(os.nome_cliente ?? "Sem nome"), os_list: [], valor_total: 0 };
            const equipment = os.equipamentos?.[0]?.equipamento?.equipamento ?? os.equipamentos?.[0]?.Equipamento?.equipamento ?? "";
            client.os_list.push({ ...os, id: String(os.id), codigo: String(os.codigo), cliente_id: clientId, valor_total: total, nome_equipamento: equipment, descricao: equipment || os.descricao || os.observacoes || "Sem descrição" });
            client.valor_total = Math.round((client.valor_total + total) * 100) / 100;
            clients.set(clientId, client);
          }
        }
      }
      return response({ success: true, clients: [...clients.values()].sort((a, b) => b.valor_total - a.valor_total), total_os: seen.size });
    }
    if (body.action === "enqueue") {
      if (actor.internal || !actor.userId) return response({ error: "A criação de negociação exige usuário autenticado." }, 403);
      negotiationDueDates(body.mes_inicio, Number(body.dia_vencimento), Number(body.parcelas));
      if (!body.cliente_gc_id || !Array.isArray(body.os_ids ?? []) || !Array.isArray(body.residual_ids ?? [])) throw new Error("Seleção de origens inválida.");
      if (body.valor_negociado != null) negotiationCents(body.valor_negociado);
      if (body.valores_parcelas != null && (!Array.isArray(body.valores_parcelas) || body.valores_parcelas.length !== Number(body.parcelas))) throw new Error("Parcelas inválidas.");
      body.valores_parcelas?.forEach(negotiationCents);
      const idempotencyKey = String(body.idempotency_key ?? "").trim();
      if (!idempotencyKey || idempotencyKey.length > 200) throw new Error("Chave de idempotência obrigatória; atualize a página e tente novamente.");
      // Whitelist business fields; never accept internal attribution, job id or execution state.
      const payload: Record<string, unknown> = {};
      for (const key of ["os_ids", "residual_ids", "cliente_gc_id", "nome_cliente", "parcelas", "dia_vencimento", "mes_inicio", "valor_negociado", "valores_parcelas", "forma_pagamento_id", "situacao_ids"]) if (body[key] !== undefined) payload[key] = body[key];
      requestMayBePersisted = true;
      const { data: job, error } = await deps.supabase.rpc("fin_enqueue_negotiation", { p_payload: payload, p_idempotency_key: idempotencyKey, p_created_by: actor.userId });
      if (error || !job?.job_id) {
        // A PostgreSQL statement error rolls the transaction back. A transport error may hide a committed enqueue.
        if (error?.code && /^(?:(?:22|23|42)[0-9A-Z]{3}|P0001|40001|40P01)$/.test(error.code)) requestMayBePersisted = false;
        throw new Error(error?.message ?? "Não foi possível confirmar a reserva das origens; mantenha a mesma chave.");
      }
      jobId = job.job_id;
      // Failure to wake the worker does not create another job; cron or an explicit retry resumes this id.
      if (job.status === "pendente") wakeWorker(job.job_id);
      return response({ success: true, ...job });
    }
    if (body.action === "resume") {
      if (actor.internal || !actor.userId) return response({ error: "Retomar exige usuário financeiro autenticado." }, 403);
      const id = String(body.job_id ?? "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Identidade do job inválida.");
      requestMayBePersisted = true;
      const { data: job, error } = await deps.supabase.rpc("fin_resume_negotiation", { p_job_id: id, p_created_by: actor.userId });
      if (error || !job?.job_id) throw new Error(error?.message ?? "Não foi possível retomar a conferência.");
      if (job.status === "pendente") wakeWorker(job.job_id);
      return response({ success: true, ...job });
    }
    if (body.action === "execute") {
      if (!actor.internal) return response({ error: "Execução financeira exclusiva do worker." }, 403);
      jobId = String(body._job_id ?? "");
      const token = String(body._execution_token ?? "");
      executionToken = token;
      if (!jobId || !token) throw new Error("Identidade do job e da execução obrigatórias.");
      const { data: claim, error: claimError } = await deps.supabase.rpc("fin_claim_negotiation_execution", { p_job_id: jobId, p_execution_token: token });
      if (claimError || claim !== true) throw new Error(claimError?.message ?? "Job já executando ou não disponível.");
      claimed = true;
      const { data: job, error } = await deps.supabase.from("fin_negociacao_jobs").select("*").eq("id", jobId).single();
      if (error || !job || job.execution_token !== token || !job.negociacao_numero) throw new Error("Job persistido inválido.");
      return response(await executeNegotiation({ supabase: deps.supabase, job, gcFetch: gc, technicalUser: deps.technicalUser, resolveOsTotal: deps.resolveOsTotal }));
    }
    return response({ error: "Ação inválida." }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = { success: false, integrity_verified: false, pending_reconciliation: claimed || requestMayBePersisted, ...(jobId ? { job_id: jobId } : {}), error: message, summary: { ok: 0, errors: 1 } };
    if (claimed && jobId) await deps.supabase.rpc("fin_finalize_negotiation", { p_job_id: jobId, p_result: result, p_execution_token: executionToken });
    return response(result, financialErrorStatus(error));
  }
}
