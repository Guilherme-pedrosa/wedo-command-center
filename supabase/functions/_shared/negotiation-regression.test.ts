import test from "node:test";
import assert from "node:assert/strict";
import { buildNegotiationPlan, negotiationDueDates, negotiationResidualDate } from "./negotiation-plan.ts";
import { executeNegotiation, osConsistent, osHeaderDiscount, receiptOsCodes } from "./negotiation-execution.ts";
import { residualScanDecision, scanNegotiationResiduals } from "./negotiation-scan.ts";
import { financialActor } from "./financial-auth.ts";
import { negotiationRequest } from "./negotiation-service.ts";

test("month-end dates preserve the intended month", () => {
  assert.deepEqual(negotiationDueDates("2026-01", 31, 3), ["2026-01-31", "2026-02-28", "2026-03-31"]);
  assert.deepEqual(negotiationDueDates("2028-01", 31, 3), ["2028-01-31", "2028-02-29", "2028-03-31"]);
  for (const args of [["2026-13", 31, 2], ["2026-01", 0, 2], ["2026-01", 31, -2]] as const) assert.throws(() => negotiationDueDates(...args));
});

test("allocation conserves every origin and every installment including cents", () => {
  let seed = 2731;
  const next = () => (seed = (seed * 16807) % 2147483647);
  for (let run = 0; run < 200; run++) {
    const sources = Array.from({ length: next() % 6 + 1 }, (_, index) => ({ key: `os:${index}`, availableCents: next() % 100000 + 1000 }));
    const total = sources.reduce((sum, o) => sum + o.availableCents, 0);
    const negotiated = Math.max(1000, next() % total);
    const parts = next() % 8 + 1;
    const plan = buildNegotiationPlan(sources, negotiated, undefined, parts);
    assert.equal(plan.remainingCents + plan.negotiatedCents, total);
    plan.origins.forEach((o) => assert.equal(o.installmentCents.reduce((a, b) => a + b, 0) + o.remainingCents, o.availableCents));
    plan.installmentCents.forEach((value, col) => assert.equal(plan.origins.reduce((sum, o) => sum + o.installmentCents[col], 0), value));
  }
  assert.throws(() => buildNegotiationPlan([{ key: "x", availableCents: 60000 }], 70000, undefined, 2));
  assert.throws(() => buildNegotiationPlan([{ key: "x", availableCents: 60000 }], 30000, [20000, 20000]));
  assert.throws(() => buildNegotiationPlan([{ key: "x", availableCents: 60000 }, { key: "x", availableCents: 60000 }], 30000));
});

function fixture(negotiated = 600, parts = 2) {
  const initial = { id: "100", codigo: "901", cliente_id: "42", nome_cliente: "Cliente teste", descricao: "Passivo OS 900", valor: "600.00", valor_total: "600.00", data_vencimento: "2026-10-15", data_competencia: "2026-09-01", plano_contas_id: "1", forma_pagamento_id: "2", conta_bancaria_id: "3", liquidado: "0" };
  const receipts = new Map<string, any>([["100", initial]]);
  const job: any = { id: "job-1", execution_token: "token", negociacao_numero: 300, payload: { cliente_gc_id: "42", os_ids: [], residual_ids: ["res-1"], valor_negociado: negotiated, parcelas: parts, dia_vencimento: 31, mes_inicio: "2026-10" }, execution_state: {} };
  const db: any = { plan: null, writes: [], failPost: false, local: null, residual: { id: "res-1", cliente_gc_id: "42", gc_recebimento_id: "100", valor_residual: 600, estado: "reservado", utilizado: true, os_codigos: ["900"] } };
  const supabase = {
    from(table: string) {
      const query: any = { update: (_: unknown) => query, select: (_: unknown) => query, eq: (_: unknown, __: unknown) => query, in: (_: unknown, __: unknown) => query, limit: (_: unknown) => query };
      const result = () => ({ data: table === "fin_negociacao_jobs" ? { id: job.id } : table === "fin_negociacao_reservas" ? [{ origin_key: "residual:res-1", estado: "reservado" }] : table === "fin_residuos_negociacao" ? db.residual : table === "fin_recebimentos" ? db.local : [], error: null });
      query.single = query.maybeSingle = async () => result();
      query.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
      return query;
    },
    async rpc(name: string, args: any) {
      if (name === "fin_persist_negotiation") { db.plan = args.p_plan; return { data: { grupo_ids: args.p_plan.parcelas.map((p: any) => `group-${p.numero}`) }, error: null }; }
      return { data: { success: true }, error: null };
    },
  };
  const gcFetch = async (endpoint: string, method = "GET", payload?: any) => {
    if (method === "POST") {
      db.writes.push({ method, endpoint, payload });
      if (db.failPost) throw new Error("GC HTTP 503");
      const id = String(100 + receipts.size);
      const record = { ...initial, ...payload, valor_total: payload.valor, id, codigo: id };
      receipts.set(id, record);
      return { data: record };
    }
    if (method === "PUT") {
      db.writes.push({ method, endpoint, payload });
      const id = endpoint.split("/").pop()!;
      const record = { ...receipts.get(id), ...payload, valor_total: payload.valor, id };
      receipts.set(id, record);
      return { data: record };
    }
    if (endpoint.includes("?")) return { data: [...receipts.values()], meta: { total_paginas: 1 } };
    return { data: receipts.get(endpoint.split("/").pop()!) };
  };
  return { deps: { supabase, job, gcFetch, resolveOsTotal: () => 0, technicalUser: "service" }, db, receipts };
}

test("real executor splits residual 600 into two GC titles and two 300 groups", async () => {
  const f = fixture();
  const result = await executeNegotiation(f.deps);
  assert.equal(result.success, true);
  assert.equal(result.integrity_verified, true);
  assert.deepEqual(f.db.plan.parcelas.map((p: any) => p.valor_cents), [30000, 30000]);
  assert.equal(f.db.plan.residuos.length, 0);
  assert.equal([...f.receipts.values()].reduce((sum, r) => sum + Number(r.valor_total), 0), 600);
  assert.deepEqual(f.db.writes.map((w: any) => w.method), ["PUT", "POST"]);
});

test("partial 300 from residual 600 preserves 300 as a separate GC-backed remaining balance", async () => {
  const f = fixture(300);
  await executeNegotiation(f.deps);
  assert.deepEqual(f.db.plan.parcelas.map((p: any) => p.valor_cents), [15000, 15000]);
  assert.equal(f.db.plan.residuos[0].valor_cents, 30000);
  assert.notEqual(f.db.plan.residuos[0].gc_id, "100");
  assert.equal([...f.receipts.values()].reduce((sum, r) => sum + Number(r.valor_total), 0), 600);
});

test("uncertain POST remains pending and cannot create a duplicate on re-entry", async () => {
  const f = fixture();
  f.db.failPost = true;
  await assert.rejects(() => executeNegotiation(f.deps), /503/);
  assert.equal(f.db.plan, null);
  const writes = f.db.writes.length;
  f.db.failPost = false;
  await assert.rejects(() => executeNegotiation(f.deps), /incerto/);
  assert.equal(f.db.writes.length, writes);
});

test("paid, changed-client, already allocated and divergent residuals fail before any GC write", async () => {
  for (const mutation of [
    (f: any) => { f.receipts.get("100").liquidado = "1"; },
    (f: any) => { f.receipts.get("100").cliente_id = "43"; },
    (f: any) => { f.db.local = { id: "local", grupo_id: "another-group" }; },
    (f: any) => { f.receipts.get("100").valor_total = "601.00"; },
  ]) {
    const f = fixture(); mutation(f);
    await assert.rejects(() => executeNegotiation(f.deps));
    assert.equal(f.db.writes.length, 0);
  }
});

test("scan never reopens used or allocated balance and preserves changed amount", () => {
  const record = { id: "1", cliente_id: "42", valor: "600", liquidado: "0" };
  assert.equal(residualScanDecision({ cliente_gc_id: "42", estado: "alocado", utilizado: true, valor_residual: 600 }, record, true, false).estado, "alocado");
  assert.equal(residualScanDecision({ cliente_gc_id: "42", estado: "reservado", utilizado: true, valor_residual: 600 }, record, false, true).estado, "reservado");
  assert.equal(residualScanDecision({ cliente_gc_id: "42", estado: "disponivel", utilizado: false, valor_residual: 601 }, record, false, false).estado, "em_revisao");
  assert.equal(residualScanDecision({ cliente_gc_id: "42", estado: "disponivel", utilizado: false, valor_residual: 600 }, { ...record, liquidado: "1" }, false, false).estado, "liquidado");
  assert.deepEqual(receiptOsCodes({ descricao: "OS 1234" }), ["1234"]);
  assert.deepEqual(receiptOsCodes({ descricao: "Título no valor 1234" }), []);
});

test("financial auth rejects missing, invalid and non-financial user credentials", async () => {
  const mock: any = { auth: { getUser: async () => ({ data: { user: null }, error: null }) } };
  await assert.rejects(() => financialActor(new Request("https://example.test"), mock, "secret"), /UNAUTHORIZED/);
  await assert.rejects(() => financialActor(new Request("https://example.test", { headers: { Authorization: "Bearer invalid" } }), mock, "secret"), /UNAUTHORIZED/);
  assert.deepEqual(await financialActor(new Request("https://example.test", { headers: { Authorization: "Bearer secret" } }), mock, "secret"), { internal: true, userId: null });
  mock.auth.getUser = async () => ({ data: { user: { id: "u" } }, error: null });
  mock.from = () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }) });
  await assert.rejects(() => financialActor(new Request("https://example.test", { headers: { Authorization: "Bearer valid-no-role" } }), mock, "secret"), /FORBIDDEN/);
});

function mixedFixture() {
  const f = fixture(600);
  f.deps.job.payload.os_ids = ["10"];
  const oldFrom = f.deps.supabase.from;
  f.deps.supabase.from = (table: string) => {
    if (table !== "fin_negociacao_reservas") return oldFrom(table);
    const query: any = { select: () => query, eq: () => query, then: (resolve: any, reject: any) => Promise.resolve({ data: [{ origin_key: "os:10", estado: "reservado" }, { origin_key: "residual:res-1", estado: "reservado" }], error: null }).then(resolve, reject) };
    return query;
  };
  const os: any = { id: "10", codigo: "1000", cliente_id: "42", tipo: "servico", data: "2026-09-01", valor_total: "600.00", valor_frete: "0.00", desconto_valor: "0.00", desconto_porcentagem: "0.00", situacao_id: "7116099", servicos: [{ servico: { servico_id: "s1", quantidade: "1.0000", valor_venda: "600.0000", valor_total: "600.00" } }], atributos: [{ atributo: { atributo_id: "77", conteudo: "Preservado" } }], pagamentos: [{ pagamento: { data_vencimento: "2026-09-30", valor: "600.00", forma_pagamento_id: "2", plano_contas_id: "1" } }] };
  const originalGC = f.deps.gcFetch;
  const control: any = { wrongIdentity: false, extraReceipt: false, failOsPut: false };
  f.deps.gcFetch = async (endpoint: string, method = "GET", payload?: any) => {
    if (!endpoint.startsWith("/api/ordens_servicos")) return originalGC(endpoint, method, payload);
    if (method === "PUT") {
      f.db.writes.push({ method, endpoint, payload });
      if (control.failOsPut) throw new Error("OS PUT 500");
      Object.assign(os, payload);
      if (String(os.situacao_id) === "7063724") {
        os.pagamentos.forEach((wrapper: any, index: number) => {
          const payment = wrapper.pagamento;
          const id = String(200 + index);
          f.receipts.set(id, { ...f.receipts.get("100"), ...payment, id, codigo: id, valor_total: payment.valor, cliente_id: "42", descricao: control.wrongIdentity ? `Ordem de serviço de nº 555 (${index + 1}/${os.pagamentos.length})` : `Ordem de serviço de nº 1000 (${index + 1}/${os.pagamentos.length})`, observacao: "" });
        });
        if (control.extraReceipt) f.receipts.set("999", { ...f.receipts.get("100"), id: "999", descricao: "Ordem de serviço de nº 1000", valor: "600.00", valor_total: "600.00" });
      }
    }
    return { data: structuredClone(os) };
  };
  return { ...f, os, control };
}

test("mixed OS plus residual preserves both origins, explicit installments and external remainder", async () => {
  const f = mixedFixture();
  const result = await executeNegotiation(f.deps);
  assert.equal(result.integrity_verified, true);
  assert.equal(f.db.plan.origins.length, 2);
  assert.deepEqual(f.db.plan.parcelas.map((p: any) => p.valor_cents), [30000, 30000]);
  assert.deepEqual(f.db.plan.parcelas.map((p: any) => p.items.length), [2, 2]);
  assert.equal(f.db.plan.residuos.reduce((sum: number, r: any) => sum + r.valor_cents, 0), 60000);
  assert.equal([...f.receipts.values()].reduce((sum, r) => sum + Number(r.valor_total), 0), 1200);
  assert.deepEqual(f.os.atributos, [{ atributo: { atributo_id: "77", conteudo: "Preservado" } }]);
});

test("OS identity mismatch, residual original left behind and failed PUT never produce completed groups", async () => {
  for (const mode of ["wrongIdentity", "extraReceipt", "failOsPut"]) {
    const f = mixedFixture();
    f.control[mode] = true;
    await assert.rejects(() => executeNegotiation(f.deps));
    assert.equal(f.db.plan, null);
  }
});

test("scan preserves all records on 429, 500, 503, invalid 200 and missing GC identity", async () => {
  for (const status of [429, 500, 503, 200]) {
    let deleted = 0, updated = 0;
    const supabase: any = { from() {
      const query: any = { select: () => query, eq: () => query, delete: () => { deleted++; return query; }, update: () => { updated++; return query; }, then: (resolve: any, reject: any) => Promise.resolve({ data: [{ id: "with-id", gc_recebimento_id: "1", estado: "disponivel" }, { id: "missing-id", gc_recebimento_id: null, estado: "pendente_vinculo" }], error: null }).then(resolve, reject) };
      return query;
    } };
    const result = await scanNegotiationResiduals(supabase, async () => { if (status !== 200) throw new Error(`GC HTTP ${status}`); return { data: {} }; });
    assert.equal(deleted, 0);
    assert.equal(updated, 1); // Only the no-ID balance is marked pending; no amount or identity is removed.
    assert.equal(result.success, false);
    assert.equal(result.removidos, 0);
    assert.ok(result.errors.length > 0);
  }
});

test("HTTP negotiation denies anonymous and direct user execution before any financial call", async () => {
  let calls = 0;
  const admin: any = { auth: { getUser: async () => ({ data: { user: { id: "user" } }, error: null }) }, from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: [{ role: "admin" }], error: null }) }) }) }) };
  const deps: any = { supabase: admin, serviceKey: "service-key", url: "https://example.test", gcHeaders: {}, technicalUser: "service", resolveOsTotal: () => 0, fetch: async () => { calls++; throw new Error("Unexpected fetch"); } };
  const anonymous = await negotiationRequest(new Request("https://example.test", { method: "POST", body: JSON.stringify({ action: "execute", os_ids: ["10"] }) }), deps);
  assert.equal(anonymous.status, 401);
  const direct = await negotiationRequest(new Request("https://example.test", { method: "POST", headers: { Authorization: "Bearer authenticated-user" }, body: JSON.stringify({ action: "execute", _job_id: "forged", os_ids: ["10"] }) }), deps);
  assert.equal(direct.status, 403);
  assert.equal(calls, 0);
});

test("failed SQL final verification cannot return execution success", async () => {
  const f = fixture();
  const original = f.deps.supabase.rpc;
  f.deps.supabase.rpc = async (name: string, args: any) => name === "fin_finalize_negotiation" ? { data: { success: false }, error: null } : original(name, args);
  await assert.rejects(() => executeNegotiation(f.deps), /verificação final/);
});

test("uncertain enqueue keeps request identity while confirmed rollback may release the draft", async () => {
  for (const [code, pending] of [["23505", false], ["", true], ["08006", true]] as const) {
    let fetches = 0;
    const admin: any = { auth: { getUser: async () => ({ data: { user: { id: "user" } }, error: null }) }, from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: [{ role: "admin" }], error: null }) }) }) }), rpc: async () => ({ data: null, error: { code, message: "enqueue interrupted" } }) };
    const result = await negotiationRequest(new Request("https://example.test", { method: "POST", headers: { Authorization: "Bearer authenticated-user" }, body: JSON.stringify({ action: "enqueue", os_ids: ["10"], residual_ids: [], cliente_gc_id: "42", mes_inicio: "2026-10", dia_vencimento: 31, parcelas: 2, valor_negociado: 600, idempotency_key: "request-00000000-0000-0000-0000-000000000001" }) }), { supabase: admin, serviceKey: "service-key", url: "https://example.test", gcHeaders: {}, technicalUser: "service", resolveOsTotal: () => 0, fetch: async () => { fetches++; throw new Error("Unexpected fetch"); } });
    const body = await result.json();
    assert.equal(body.success, false);
    assert.equal(body.pending_reconciliation, pending);
    assert.equal(fetches, 0);
  }
});

// Mirrors the ERP contract observed on 16/09/2026: a PUT without `desconto_valor` zeroes the header discount
// but keeps `valor_total`; a payment plan whose total differs from lines + freight - discount is refused.
function discountFixture(options: { parts?: number; osState?: Record<string, any>; steps?: Record<string, any>; withPlan?: boolean } = {}) {
  const parts = options.parts ?? 1;
  const f = fixture(510.84, parts);
  f.deps.job.payload = { cliente_gc_id: "42", os_ids: ["10"], residual_ids: [], valor_negociado: 510.84, parcelas: parts, dia_vencimento: 18, mes_inicio: "2026-09" };
  const oldFrom = f.deps.supabase.from;
  f.deps.supabase.from = (table: string) => {
    if (table !== "fin_negociacao_reservas") return oldFrom(table);
    const query: any = { select: () => query, eq: () => query, then: (resolve: any, reject: any) => Promise.resolve({ data: [{ origin_key: "os:10", estado: "reservado" }], error: null }).then(resolve, reject) };
    return query;
  };
  const snapshot: any = {
    id: "10", codigo: "1000", cliente_id: "42", tipo: "servico", data: "2026-09-01", situacao_id: "7116099", nome_situacao: "EXECUTADO - AGUARDANDO NEGOCIAÇÃO FINANCEIRA",
    valor_total: "510.84", valor_produtos: "128.80", valor_servicos: "439.00", valor_frete: "0.00", desconto_valor: "56.96", desconto_porcentagem: "0.00", condicao_pagamento: "a_vista", forma_pagamento_id: "", numero_parcelas: "",
    produtos: [{ produto: { produto_id: "p1", quantidade: "1.0000", valor_venda: "128.8000", valor_total: "128.80", desconto_valor: "0.0000" } }],
    servicos: [{ servico: { servico_id: "s1", quantidade: "1.0000", valor_venda: "439.0000", valor_total: "439.00" } }],
    atributos: [{ atributo: { atributo_id: "77", conteudo: "Preservado" } }],
    pagamentos: [{ pagamento: { data_vencimento: "2026-09-01", valor: "510.84", forma_pagamento_id: "2", plano_contas_id: "1" } }],
  };
  const os: any = structuredClone({ ...snapshot, ...(options.osState ?? {}) });
  const dates = negotiationDueDates("2026-09", 18, parts);
  if (options.withPlan) {
    const plan = buildNegotiationPlan([{ key: "os:10", availableCents: 51084 }], 51084, undefined, parts);
    f.deps.job.execution_state = { plan: { dates, residualDate: negotiationResidualDate(dates[dates.length - 1]), ...plan, sources: [{ key: "os:10", id: "10", kind: "os", codigo: "1000", os_codigos: ["1000"], raw: structuredClone(snapshot), availableCents: 51084 }] }, steps: structuredClone(options.steps ?? {}) };
  }
  const cents = (v: unknown) => Math.round(Number(v) * 100);
  const originalGC = f.deps.gcFetch;
  f.deps.gcFetch = async (endpoint: string, method = "GET", payload?: any) => {
    if (!endpoint.startsWith("/api/ordens_servicos")) return originalGC(endpoint, method, payload);
    if (method === "PUT") {
      f.db.writes.push({ method, endpoint, payload });
      const lines = [...(payload.produtos ?? []).map((w: any) => w.produto), ...(payload.servicos ?? []).map((w: any) => w.servico)].reduce((sum: number, line: any) => sum + cents(line.valor_total), 0) + cents(payload.valor_frete ?? 0);
      const discount = payload.desconto_valor === undefined ? 0 : cents(payload.desconto_valor);
      if (payload.numero_parcelas !== undefined && Array.isArray(payload.pagamentos)) {
        const planned = payload.pagamentos.reduce((sum: number, w: any) => sum + cents(w.pagamento.valor), 0);
        if (lines - discount !== planned) throw new Error(`GC PUT ${endpoint} falhou (HTTP 404): O valor do pedido não pode ser diferente do valor das parcelas, está faltando ${((lines - discount - planned) / 100).toFixed(2)}`);
      }
      Object.assign(os, payload, { desconto_valor: (discount / 100).toFixed(2), valor_total: os.valor_total });
      if (String(os.situacao_id) === "7063724") os.pagamentos.forEach((wrapper: any, index: number) => {
        const p = wrapper.pagamento;
        const id = String(300 + index);
        f.receipts.set(id, { ...f.receipts.get("100"), ...p, id, codigo: id, valor_total: p.valor, cliente_id: "42", descricao: `Ordem de serviço de nº 1000 (${index + 1}/${os.pagamentos.length})`, observacao: "" });
      });
    }
    return { data: structuredClone(os) };
  };
  return { ...f, os, snapshot, dates };
}

test("header discount is reconciled from lines and restored from the plan only when it explains the total", () => {
  const raw = { codigo: "1000", valor_total: "510.84", valor_frete: "0.00", desconto_valor: "56.96", produtos: [{ produto: { valor_total: "128.80" } }], servicos: [{ servico: { valor_total: "439.00" } }] };
  assert.deepEqual(osHeaderDiscount(raw), { desconto_valor: "56.96", desconto_porcentagem: "0.00" });
  assert.deepEqual(osHeaderDiscount({ ...raw, desconto_valor: "0.00" }, raw), { desconto_valor: "56.96", desconto_porcentagem: "0.00" });
  assert.throws(() => osHeaderDiscount({ ...raw, desconto_valor: "0.00" }), /total R\$ 510\.84 não fecha.*567\.80/);
  assert.throws(() => osHeaderDiscount({ ...raw, desconto_valor: "0.00" }, { ...raw, desconto_valor: "10.00" }), /não fecha/);
  assert.equal(osConsistent(raw, 51084), true);
  assert.equal(osConsistent({ ...raw, desconto_valor: "0.00" }, 51084), false);
  assert.equal(osConsistent(raw, 51085), false);
  assert.deepEqual(osHeaderDiscount({ valor_total: "600.00" }), { desconto_valor: "0.00", desconto_porcentagem: "0.00" });
});

test("OS header discount travels with every PUT and a single installment keeps the proven a_vista contract", async () => {
  const f = discountFixture();
  const result = await executeNegotiation(f.deps);
  assert.equal(result.integrity_verified, true);
  assert.equal(f.os.desconto_valor, "56.96");
  assert.equal(f.os.situacao_id, "7063724");
  const puts = f.db.writes.filter((w: any) => w.endpoint === "/api/ordens_servicos/10");
  assert.equal(puts.length, 3);
  assert.ok(puts.every((w: any) => w.payload.desconto_valor === "56.96"));
  assert.equal(puts[1].payload.condicao_pagamento, "a_vista");
  assert.equal(puts[1].payload.intervalo_dias, "0");
  assert.equal(puts[1].payload.numero_parcelas, "1");
  assert.equal(puts[1].payload.data_primeira_parcela, "2026-09-18");
  assert.equal(puts[1].payload.forma_pagamento_id, "2");
  assert.deepEqual(f.db.plan.parcelas.map((p: any) => p.valor_cents), [51084]);
});

test("several installments are sent as an explicit monthly plan with the header discount preserved", async () => {
  const f = discountFixture({ parts: 2 });
  await executeNegotiation(f.deps);
  const stageB = f.db.writes.filter((w: any) => w.endpoint === "/api/ordens_servicos/10")[1].payload;
  assert.equal(stageB.condicao_pagamento, "parcelado");
  assert.equal(stageB.intervalo_dias, "30");
  assert.equal(stageB.numero_parcelas, "2");
  assert.equal(stageB.desconto_valor, "56.96");
  assert.deepEqual(stageB.pagamentos.map((w: any) => w.pagamento.data_vencimento), ["2026-09-18", "2026-10-18"]);
  assert.deepEqual(f.db.plan.parcelas.map((p: any) => p.valor_cents), [25542, 25542]);
  assert.equal(f.os.desconto_valor, "56.96");
});

test("resuming after the ERP dropped the header discount restores it from the persisted plan", async () => {
  const stageA = { status: "verified", method: "PUT", endpoint: "/api/ordens_servicos/10", payload: { situacao_id: "8896431" }, started_at: "2026-09-16T13:50:55.845Z" };
  const stageB = { status: "dispatching", method: "PUT", endpoint: "/api/ordens_servicos/10", payload: { situacao_id: "8896431", condicao_pagamento: "a_vista" }, started_at: "2026-09-16T13:50:57.903Z" };
  const f = discountFixture({ withPlan: true, steps: { "os:10:A": stageA, "os:10:B": stageB }, osState: { situacao_id: "8896431", desconto_valor: "0.00" } });
  const result = await executeNegotiation(f.deps);
  assert.equal(result.integrity_verified, true);
  const puts = f.db.writes.filter((w: any) => w.endpoint === "/api/ordens_servicos/10");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].payload.desconto_valor, "56.96");
  assert.equal(puts[0].payload.numero_parcelas, "1");
  assert.equal(f.os.desconto_valor, "56.96");
  assert.equal(f.os.situacao_id, "7063724");
});

test("a release undone by hand is re-applied when the payment plan is intact", async () => {
  const verified = (situacao: string) => ({ status: "verified", method: "PUT", endpoint: "/api/ordens_servicos/10", payload: { situacao_id: situacao }, started_at: "2026-09-16T14:22:32.194Z" });
  const planned = [{ pagamento: { data_vencimento: "2026-09-18", valor: "510.84", forma_pagamento_id: "2", plano_contas_id: "1", observacao: "" } }];
  const f = discountFixture({ withPlan: true, steps: { "os:10:A": verified("8896431"), "os:10:B": verified("8896431"), "os:10:C": verified("7063724") }, osState: { situacao_id: "7116099", condicao_pagamento: "a_vista", numero_parcelas: "1", data_primeira_parcela: "2026-09-18", pagamentos: planned } });
  const result = await executeNegotiation(f.deps);
  assert.equal(result.integrity_verified, true);
  const puts = f.db.writes.filter((w: any) => w.endpoint === "/api/ordens_servicos/10");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].payload.situacao_id, "7063724");
  assert.equal(puts[0].payload.desconto_valor, "56.96");
  assert.equal(f.os.situacao_id, "7063724");
  assert.equal(f.db.plan.parcelas[0].items.length, 1);
});

test("payments changed after the release are reported with the OS code and both states, without writes", async () => {
  const verified = (situacao: string) => ({ status: "verified", method: "PUT", endpoint: "/api/ordens_servicos/10", payload: { situacao_id: situacao }, started_at: "2026-09-16T14:22:32.194Z" });
  const changed = [{ pagamento: { data_vencimento: "2026-10-01", valor: "510.84", forma_pagamento_id: "2", plano_contas_id: "1" } }];
  const f = discountFixture({ withPlan: true, steps: { "os:10:A": verified("8896431"), "os:10:B": verified("8896431"), "os:10:C": verified("7063724") }, osState: { situacao_id: "7063724", pagamentos: changed } });
  await assert.rejects(() => executeNegotiation(f.deps), (error: Error) => /OS 1000/.test(error.message) && /2026-10-01/.test(error.message) && /2026-09-18/.test(error.message) && /7063724/.test(error.message));
  assert.equal(f.db.writes.length, 0);
  assert.equal(f.db.plan, null);
});

test("an OS whose total no longer closes with its lines stops before any write", async () => {
  const f = discountFixture({ osState: { desconto_valor: "0.00" } });
  await assert.rejects(() => executeNegotiation(f.deps), /OS 1000: total R\$ 510\.84 não fecha/);
  assert.equal(f.db.writes.length, 0);
  assert.equal(f.db.plan, null);
});
