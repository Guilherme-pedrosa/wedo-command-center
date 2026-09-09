import { buildNegotiationPlan, negotiationCents, negotiationDueDates, negotiationResidualDate } from "./negotiation-plan.ts";

type RecordData = Record<string, any>;
type Dependencies = { supabase: any; job: RecordData; gcFetch: (endpoint: string, method?: string, body?: unknown) => Promise<any>; resolveOsTotal: (raw: RecordData) => number; technicalUser: string };
const money = (cents: number) => (cents / 100).toFixed(2);
const unwrap = (raw: any): RecordData => raw?.Recebimento ?? raw?.recebimento ?? raw?.pagamento ?? raw?.Pagamento ?? raw;
const closed = (raw: RecordData) => raw.liquidado === true || String(raw.liquidado) === "1" || /cancel|liquidad|recebid/i.test(String(raw.situacao_nome ?? raw.situacao ?? ""));
const explicitlyOpen = (raw: RecordData) => ["0", 0, false].includes(raw?.liquidado) && !closed(raw);
const receiptCents = (raw: RecordData) => negotiationCents(raw.valor_total ?? raw.valor);

export function receiptOsCodes(raw: RecordData): string[] {
  const result = new Set<string>();
  const text = `${raw.descricao ?? ""} ${raw.observacoes ?? ""} ${raw.observacao ?? ""}`;
  for (const match of text.matchAll(/\bOS\s+(\d+)\b|ordem\s+de\s+servi[çc]o\s+de\s+n[ºo°]\s*(\d+)\b/gi)) result.add(match[1] ?? match[2]);
  return [...result];
}

function belongsToOS(receipt: RecordData, origin: RecordData): boolean {
  const id = receipt.ordem_servico_id ?? receipt.ordem_servicos_id ?? receipt.os_id;
  if (id) return String(id) === origin.id;
  const codes = receiptOsCodes(receipt);
  return codes.length === 1 && codes[0] === origin.codigo;
}

function assertReceipt(raw: RecordData, client: string, cents?: number, date?: string) {
  if (!raw?.id || String(raw.cliente_id) !== client || !explicitlyOpen(raw)) throw new Error("Título inexistente, liquidado, cancelado, sem estado confirmado ou de outro cliente.");
  if (cents !== undefined && receiptCents(raw) !== cents) throw new Error(`Valor do título GC ${raw.id} diverge do plano.`);
  if (date && String(raw.data_vencimento).slice(0, 10) !== date) throw new Error(`Vencimento do título GC ${raw.id} diverge do plano.`);
}

function requiredReceiptPayload(raw: RecordData): RecordData {
  const keys = ["plano_contas_id", "forma_pagamento_id", "conta_bancaria_id", "data_competencia"];
  for (const key of keys) if (!raw[key]) throw new Error(`Título ${raw.id}: campo obrigatório ${key} ausente no GC.`);
  const result: RecordData = {};
  for (const key of [...keys, "centro_custo_id", "cliente_id", "entidade"]) if (raw[key] != null) result[key] = raw[key];
  result.entidade = "C";
  return result;
}

const osKeys = ["tipo", "codigo", "cliente_id", "data", "vendedor_id", "tecnico_id", "saida", "previsao_entrega", "transportadora_id", "centro_custo_id", "aos_cuidados_de", "validade", "introducao", "observacoes", "observacoes_interna", "valor_frete", "desconto", "condicao_pagamento", "forma_pagamento_id", "data_primeira_parcela", "numero_parcelas", "intervalo_dias", "equipamentos", "pagamentos", "produtos", "servicos", "campos_personalizados", "campos_customizados", "campos_extras", "atributos"];
function osPayload(raw: RecordData, technicalUser: string): RecordData {
  const result: RecordData = { usuario_id: technicalUser };
  for (const key of osKeys) if (raw[key] != null && raw[key] !== "") result[key] = raw[key];
  if (Array.isArray(raw.atributos)) result.atributos = raw.atributos.map((wrapper: any) => {
    const attribute = wrapper.atributo ?? wrapper;
    return { atributo: { atributo_id: String(attribute.atributo_id ?? attribute.id), conteudo: String(attribute.conteudo ?? "") } };
  });
  return result;
}

export async function executeNegotiation(deps: Dependencies) {
  const { supabase, job, gcFetch: gc, resolveOsTotal, technicalUser } = deps;
  const request = job.payload;
  const client = String(request.cliente_gc_id ?? "");
  const state: RecordData = job.execution_state ?? {};
  state.steps ??= {};
  const persistState = async () => {
    const { error, data } = await supabase.from("fin_negociacao_jobs").update({ execution_state: state }).eq("id", job.id).eq("execution_token", job.execution_token).select("id").single();
    if (error || !data) throw new Error(`Não foi possível persistir a etapa: ${error?.message ?? "execução não é mais proprietária do job"}`);
  };
  const listReceipts = async (): Promise<RecordData[]> => {
    const records: RecordData[] = [];
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      if (page > 500) throw new Error("Consulta de títulos excedeu o limite; nenhuma conclusão por lista incompleta.");
      const response = await gc(`/api/recebimentos?${new URLSearchParams({ cliente_id: client, limite: "100", pagina: String(page), data_inicio: "2000-01-01", data_fim: "2100-12-31" })}`);
      if (!Array.isArray(response.data)) throw new Error("Consulta de títulos incompleta ou inválida no GC.");
      pages = Number(response.meta?.total_paginas ?? 1);
      if (!Number.isInteger(pages) || pages < 1) throw new Error("Paginação inválida no GC.");
      records.push(...response.data.map(unwrap));
    }
    return records;
  };
  const getReceipt = async (id: string) => unwrap((await gc(`/api/recebimentos/${encodeURIComponent(id)}`)).data);
  const getOS = async (id: string) => (await gc(`/api/ordens_servicos/${encodeURIComponent(id)}`)).data;

  // A write is recorded BEFORE dispatch. An uncertain POST is never automatically sent twice.
  const mutation = async (key: string, endpoint: string, method: "PUT" | "POST", payload: RecordData, verify: (raw: RecordData) => boolean, recover?: () => Promise<RecordData | undefined>) => {
    const previous = state.steps[key];
    if (previous) {
      let current: RecordData | undefined;
      if (method === "PUT") current = (await gc(endpoint)).data;
      else if (previous.id) current = await getReceipt(previous.id);
      else if (recover) current = await recover();
      if (!current || !verify(current)) throw new Error(`Etapa ${key} tem efeito externo incerto; conferir antes de repetir.`);
      state.steps[key] = { ...previous, status: "verified", id: String(current.id), result: current };
      await persistState();
      return current;
    }
    state.steps[key] = { status: "dispatching", method, endpoint, payload, started_at: new Date().toISOString() };
    await persistState();
    const response = await gc(endpoint, method, payload);
    const created = unwrap(response.data);
    const id = method === "PUT" ? endpoint.split("/").pop() : created?.id;
    if (!id) throw new Error(`Etapa ${key}: GC não retornou identidade do título criado.`);
    state.steps[key] = { ...state.steps[key], id: String(id), status: "responded" };
    await persistState();
    const checked = (await gc(method === "POST" ? `/api/recebimentos/${id}` : endpoint)).data;
    if (!verify(checked)) throw new Error(`Etapa ${key}: GC não confirmou o resultado planejado.`);
    state.steps[key] = { ...state.steps[key], status: "verified", result: checked };
    await persistState();
    return checked;
  };

  if (!state.plan) {
    const dates = negotiationDueDates(request.mes_inicio, Number(request.dia_vencimento), Number(request.parcelas));
    const osIds: string[] = request.os_ids ?? [];
    const residualIds: string[] = request.residual_ids ?? [];
    if (!client || (!osIds.length && !residualIds.length) || new Set(osIds).size !== osIds.length || new Set(residualIds).size !== residualIds.length) throw new Error("Cliente ou seleção de origens inválidos.");
    const { data: reservations, error: reservationError } = await supabase.from("fin_negociacao_reservas").select("origin_key,estado").eq("job_id", job.id);
    const expectedKeys = [...osIds.map((id) => `os:${id}`), ...residualIds.map((id) => `residual:${id}`)].sort();
    if (reservationError || JSON.stringify((reservations ?? []).filter((r: any) => r.estado === "reservado").map((r: any) => r.origin_key).sort()) !== JSON.stringify(expectedKeys)) throw new Error("Reservas do job não correspondem às origens solicitadas.");
    const origins: RecordData[] = [];
    const sourceCodes = new Set<string>();
    const allReceipts = osIds.length ? await listReceipts() : [];
    for (const id of osIds) {
      const raw = await getOS(id);
      if (!raw?.id || String(raw.id) !== id || String(raw.cliente_id) !== client) throw new Error("OS inexistente ou pertencente a outro cliente.");
      if (String(raw.situacao_id) !== "7116099") throw new Error(`OS ${raw.codigo}: situação atual não permite nova negociação.`);
      // The ERP's explicit OS total is the obligation; never silently replace it with a heuristic sum.
      const origin = { key: `os:${id}`, id, kind: "os", codigo: String(raw.codigo), os_codigos: [String(raw.codigo)], raw, availableCents: negotiationCents(raw.valor_total) };
      if (!origin.availableCents) throw new Error(`OS ${origin.codigo}: total explícito ausente ou igual a zero.`);
      if (sourceCodes.has(origin.codigo)) throw new Error("Código de OS repetido entre origens.");
      sourceCodes.add(origin.codigo);
      const prior = allReceipts.filter((r) => belongsToOS(r, origin));
      if (prior.some((r) => closed(r))) throw new Error(`OS ${origin.codigo} possui título pago/cancelado; requer conciliação antes de renegociar.`);
      const payments = (raw.pagamentos ?? []).map(unwrap);
      if (payments.some(closed)) throw new Error(`OS ${origin.codigo} possui pagamento liquidado.`);
      const form = payments[0]?.forma_pagamento_id || raw.forma_pagamento_id || request.forma_pagamento_id;
      const accountPlan = payments[0]?.plano_contas_id || payments[0]?.categoria_id;
      if (!form || !accountPlan) throw new Error(`OS ${origin.codigo}: forma de pagamento ou plano de contas ausente.`);
      for (const receipt of prior) assertReceipt(receipt, client);
      const { data: local, error } = await supabase.from("fin_recebimentos").select("id,grupo_id,liquidado").eq("os_codigo", origin.codigo).eq("cliente_gc_id", client);
      if (error) throw error;
      if ((local ?? []).some((r: any) => r.grupo_id || r.liquidado)) throw new Error(`OS ${origin.codigo} já está alocada ou paga.`);
      if (local?.length) {
        const { data: links, error: linkError } = await supabase.from("fin_grupo_receber_itens").select("id").in("recebimento_id", local.map((r: any) => r.id)).limit(1);
        if (linkError || links?.length) throw new Error(`OS ${origin.codigo} possui alocação existente.`);
      }
      origins.push(origin);
    }
    for (const id of residualIds) {
      const { data: residual, error } = await supabase.from("fin_residuos_negociacao").select("*").eq("id", id).single();
      if (error || !residual || (residual.utilizado && residual.estado !== "reservado") || !["disponivel", "reservado", null, undefined].includes(residual.estado) || String(residual.cliente_gc_id) !== client || !residual.gc_recebimento_id) throw new Error("Saldo indisponível, sem título confirmado ou de outro cliente.");
      const raw = await getReceipt(String(residual.gc_recebimento_id));
      const cents = negotiationCents(residual.valor_residual);
      assertReceipt(raw, client, cents);
      requiredReceiptPayload(raw);
      if (!cents) throw new Error("Saldo residual igual a zero.");
      if ([raw.juros, raw.desconto, raw.taxa_banco, raw.taxa_operadora].some((v) => negotiationCents(v ?? 0) !== 0)) throw new Error(`Saldo ${id} tem juros, desconto ou taxa; confirmar o valor líquido antes de dividir.`);
      const codes = residual.os_codigos ?? [];
      if (codes.some((code: string) => sourceCodes.has(code))) throw new Error("A mesma OS foi selecionada como serviço e saldo anterior.");
      codes.forEach((code: string) => sourceCodes.add(code));
      const { data: local, error: localError } = await supabase.from("fin_recebimentos").select("id,grupo_id,liquidado").eq("gc_id", String(raw.id)).maybeSingle();
      if (localError || local?.grupo_id || local?.liquidado) throw new Error("Saldo já está alocado ou pago no sistema.");
      if (local?.id) {
        const { data: links, error: linkError } = await supabase.from("fin_grupo_receber_itens").select("id").eq("recebimento_id", local.id).limit(1);
        if (linkError || links?.length) throw new Error("Saldo possui vínculo em outro grupo.");
      }
      origins.push({ key: `residual:${id}`, id, kind: "residual", raw, os_codigos: codes, availableCents: cents });
    }
    const total = origins.reduce((sum, origin) => sum + origin.availableCents, 0);
    const plan = buildNegotiationPlan(origins.map((o) => ({ key: o.key, availableCents: o.availableCents })), request.valor_negociado == null ? total : negotiationCents(request.valor_negociado), request.valores_parcelas?.map(negotiationCents), Number(request.parcelas));
    state.plan = { dates, residualDate: negotiationResidualDate(dates[dates.length - 1]), ...plan, sources: origins };
    await persistState();
  }

  const plan = state.plan;
  const output: RecordData = {
    version: 2, cliente_gc_id: client, nome_cliente: request.nome_cliente || plan.sources[0]?.raw.nome_cliente || "Cliente", negociacao_numero: job.negociacao_numero,
    total_original_cents: plan.totalCents, negotiated_cents: plan.negotiatedCents, remaining_cents: plan.remainingCents,
    origins: plan.sources.map((o: any) => ({ origin_key: o.key, available_cents: o.availableCents, os_codigos: o.os_codigos })),
    parcelas: plan.dates.map((date: string, i: number) => ({ numero: i + 1, data_vencimento: date, valor_cents: plan.installmentCents[i], items: [] })),
    residuos: [], consumed_residual_ids: [],
  };
  const uniqueIds = new Set<string>();
  const append = async (origin: RecordData, segment: RecordData, candidate: RecordData) => {
    const record = await getReceipt(String(candidate.id));
    assertReceipt(record, client, segment.cents, segment.date);
    const id = String(record.id);
    if (uniqueIds.has(id)) throw new Error(`Título ${id} corresponde a mais de uma alocação.`);
    uniqueIds.add(id);
    if (segment.kind === "residual") output.residuos.push({ origin_key: origin.key, source_residual_id: origin.kind === "residual" ? origin.id : undefined, gc_id: id, gc_codigo: record.codigo ? String(record.codigo) : null, os_codigos: origin.os_codigos, valor_cents: segment.cents, data_vencimento: segment.date, recebimento: record });
    else output.parcelas[segment.index].items.push({ origin_key: origin.key, gc_id: id, gc_codigo: record.codigo ? String(record.codigo) : null, os_codigo: origin.os_codigos[0] ?? null, valor_cents: segment.cents, recebimento: record });
  };

  for (const origin of plan.sources) {
    const allocation = plan.origins.find((o: any) => o.key === origin.key);
    const segments: RecordData[] = allocation.installmentCents.map((cents: number, index: number) => ({ kind: "parcela", index, cents, date: plan.dates[index] })).filter((s: any) => s.cents > 0);
    if (allocation.remainingCents > 0) segments.push({ kind: "residual", cents: allocation.remainingCents, date: plan.residualDate });
    for (const segment of segments) segment.marker = `WEDO:${job.id}:${origin.key}:${segment.kind === "residual" ? "R" : `P${segment.index + 1}`}`;

    if (origin.kind === "residual") {
      const sourcePayload = requiredReceiptPayload(origin.raw);
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const key = `${origin.key}:${segment.kind === "residual" ? "R" : segment.index + 1}`;
        const payload = { ...sourcePayload, descricao: `${segment.kind === "residual" ? "Passivo" : `NEG${job.negociacao_numero}`} ${origin.os_codigos.map((c: string) => `OS ${c}`).join(", ")} [${segment.marker}]`, data_vencimento: segment.date, valor: money(segment.cents), juros: "0.00", desconto: "0.00", liquidado: "0", usuario_id: technicalUser };
        const verify = (raw: RecordData) => !!raw?.id && String(raw.cliente_id) === client && explicitlyOpen(raw) && receiptCents(raw) === segment.cents && String(raw.data_vencimento).slice(0, 10) === segment.date && String(raw.descricao).includes(segment.marker);
        // The original is reduced first; remaining obligations are journaled and stay reserved until all segments verify.
        if (i === 0 && !state.steps[key]) assertReceipt(await getReceipt(String(origin.raw.id)), client, origin.availableCents);
        const record = await mutation(key, i === 0 ? `/api/recebimentos/${origin.raw.id}` : "/api/recebimentos", i === 0 ? "PUT" : "POST", payload, verify, async () => {
          const candidates = (await listReceipts()).filter((r) => String(r.descricao).includes(segment.marker));
          if (candidates.length > 1) throw new Error("Mais de um título possui a identidade da etapa.");
          return candidates[0];
        });
        await append(origin, segment, record);
      }
      output.consumed_residual_ids.push(origin.id);
      continue;
    }

    const original = origin.raw;
    const payment = unwrap(original.pagamentos?.[0] ?? {});
    const payments = segments.map((segment) => ({ pagamento: {
      data_vencimento: segment.date, valor: money(segment.cents), forma_pagamento_id: payment.forma_pagamento_id || original.forma_pagamento_id || request.forma_pagamento_id,
      plano_contas_id: payment.plano_contas_id || payment.categoria_id, observacao: segment.marker,
    } }));
    const endpoint = `/api/ordens_servicos/${origin.id}`;
    const stageAKey = `${origin.key}:A`, stageBKey = `${origin.key}:B`, stageCKey = `${origin.key}:C`;
    // Completed stages must not replay old statuses when resuming a later stage.
    if (!state.steps[stageAKey]) {
      const fresh = await getOS(origin.id);
      if (String(fresh.cliente_id) !== client || String(fresh.situacao_id) !== "7116099" || negotiationCents(fresh.valor_total) !== origin.availableCents) throw new Error("OS mudou desde a validação inicial; negociação interrompida.");
      await mutation(stageAKey, endpoint, "PUT", { ...osPayload(fresh, technicalUser), situacao_id: "8896431" }, (r) => String(r?.id) === origin.id && String(r.situacao_id) === "8896431");
    } else if (state.steps[stageAKey].status !== "verified" && !state.steps[stageBKey]) {
      await mutation(stageAKey, endpoint, "PUT", state.steps[stageAKey].payload, (r) => String(r?.id) === origin.id && String(r.situacao_id) === "8896431");
    }
    const verifyPayments = (raw: RecordData) => {
      const actual = (raw?.pagamentos ?? []).map(unwrap);
      return String(raw?.id) === origin.id && String(raw.cliente_id) === client && actual.length === segments.length && actual.every((p: any, i: number) => negotiationCents(p.valor) === segments[i].cents && String(p.data_vencimento).slice(0, 10) === segments[i].date);
    };
    if (!state.steps[stageBKey] || state.steps[stageBKey].status !== "verified") {
      const fresh = await getOS(origin.id);
      await mutation(stageBKey, endpoint, "PUT", { ...osPayload(fresh, technicalUser), situacao_id: "8896431", data_primeira_parcela: segments[0].date, numero_parcelas: String(payments.length), condicao_pagamento: payments.length > 1 ? "parcelado" : "a_vista", intervalo_dias: payments.length > 1 ? "30" : "0", pagamentos: payments }, verifyPayments);
    }
    if (!state.steps[stageCKey] || state.steps[stageCKey].status !== "verified") {
      const fresh = await getOS(origin.id);
      if (!verifyPayments(fresh)) throw new Error("Plano de pagamentos da OS mudou antes da liberação financeira.");
      await mutation(stageCKey, endpoint, "PUT", { ...osPayload(fresh, technicalUser), situacao_id: "7063724" }, (r) => verifyPayments(r) && String(r.situacao_id) === "7063724");
    }
    const currentOS = await getOS(origin.id);
    if (!verifyPayments(currentOS) || String(currentOS.situacao_id) !== "7063724") throw new Error("OS final diverge do plano persistido.");
    const receipts = await listReceipts();
    const originReceipts = receipts.filter((r) => String(r.cliente_id) === client && (belongsToOS(r, origin) || String(r.descricao ?? "").includes(`WEDO:${job.id}:${origin.key}:`)));
    if (originReceipts.length !== segments.length || originReceipts.some((r) => !explicitlyOpen(r)) || originReceipts.reduce((sum, r) => sum + receiptCents(r), 0) !== origin.availableCents) throw new Error(`OS ${origin.codigo}: quantidade ou saldo dos títulos gerados não fecha com a origem.`);
    for (const segment of segments) {
      const candidates = originReceipts.filter((r) => {
        if (String(r.cliente_id) !== client || !explicitlyOpen(r)) return false;
        const explicitMarker = `${r.descricao ?? ""} ${r.observacoes ?? ""} ${r.observacao ?? ""}`.includes(segment.marker);
        // Identity (marker or exact OS) is mandatory; amount/date alone never identify a receivable.
        return (explicitMarker || belongsToOS(r, origin)) && receiptCents(r) === segment.cents && String(r.data_vencimento).slice(0, 10) === segment.date;
      });
      if (candidates.length !== 1) throw new Error(`OS ${origin.codigo}: financeiro ausente ou ambíguo para ${segment.marker}.`);
      await append(origin, segment, candidates[0]);
    }
  }

  for (const installment of output.parcelas) if (!installment.items.length || installment.items.reduce((sum: number, item: any) => sum + item.valor_cents, 0) !== installment.valor_cents) throw new Error("Composição da parcela não corresponde ao plano.");
  state.verified_plan = output;
  await persistState();
  const { data: persisted, error: persistError } = await supabase.rpc("fin_persist_negotiation", { p_job_id: job.id, p_plan: output, p_execution_token: job.execution_token });
  if (persistError || !Array.isArray(persisted?.grupo_ids) || persisted.grupo_ids.length !== output.parcelas.length) throw new Error(`Falha ao consolidar negociação: ${persistError?.message ?? "grupos incompletos"}`);
  const result = { success: true, integrity_verified: true, negociacao_numero: job.negociacao_numero, grupo_ids: persisted.grupo_ids, grupos_criados: persisted.grupo_ids.length, summary: { total: plan.sources.length, ok: plan.sources.length, errors: 0 }, residual_results: output.consumed_residual_ids.map((id: string) => ({ id, status: "ok" })), results: plan.sources.filter((o: any) => o.kind === "os").map((o: any) => ({ os_id: o.id, status: "ok" })) };
  const { data: finalized, error: finalError } = await supabase.rpc("fin_finalize_negotiation", { p_job_id: job.id, p_result: result, p_execution_token: job.execution_token });
  if (finalError || finalized?.success !== true) throw new Error(`Consolidação pendente: ${finalError?.message ?? "verificação final do banco recusou a conclusão"}`);
  return result;
}
