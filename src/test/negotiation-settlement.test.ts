import { describe, expect, it, vi } from "vitest";
import { assertNegotiationSettlement, verifyNegotiationGroup } from "../../supabase/functions/_shared/negotiation-settlement";

function fixture() {
  const rec = { id: "r1", gc_id: "100", grupo_id: "g1", cliente_gc_id: "client1", os_codigo: "9000", valor: 600 };
  const db: Record<string, any[]> = {
    fin_recebimentos: [rec],
    fin_grupos_receber: [{ id: "g1", status: "aberto", bloqueio_financeiro: false, integridade_status: "ok", itens_total: 1, valor_total: 600, cliente_gc_id: "client1", os_codigos: ["9000"] }],
    fin_grupo_receber_itens: [{ grupo_id: "g1", recebimento_id: "r1", valor: 600, os_codigo_original: "9000", fin_recebimentos: rec }],
    fin_audit_log: [],
    fin_extrato_lancamentos: [{ lancamento_id: "r1", tabela: "recebimentos", valor_alocado: 600, fin_extrato_inter: { reconciliado: true } }],
  };
  let completeFacts = true;
  const admin = { rpc: vi.fn(async () => ({ data: { completo: completeFacts }, error: null })), from: (table: string) => {
    const predicates: Array<(r: any) => boolean> = [];
    let operation = "select", payload: any;
    const result = () => {
      const rows = db[table].filter(r => predicates.every(p => p(r)));
      if (operation === "update") { rows.forEach(r => Object.assign(r, payload)); operation = "select"; }
      if (operation === "insert") { db[table].push(payload); operation = "select"; return { data: [payload], error: null }; }
      return { data: rows, error: null };
    };
    const query: any = {
      select: () => query,
      update: (value: any) => { operation = "update"; payload = value; return query; },
      insert: (value: any) => { operation = "insert"; payload = value; return query; },
      eq: (key: string, value: unknown) => { predicates.push(r => r[key] === value); return query; },
      in: (key: string, values: unknown[]) => { predicates.push(r => values.includes(r[key])); return query; },
      maybeSingle: async () => { const r = result(); return { ...r, data: r.data[0] || null }; },
      single: async () => { const r = result(); return { ...r, data: r.data[0] || null }; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return query;
  } };
  const fresh = { id: "100", cliente_id: "client1", valor_total: "600.00", liquidado: "0", descricao: "OS 9000", data_vencimento: "2026-09-30" };
  const getReceipt = vi.fn(async () => fresh);
  return { db, admin, fresh, getReceipt, setIncomplete: () => { completeFacts = false; } };
}

describe("barreira compartilhada da baixa de negociação", () => {
  it("autoriza somente composição completa com banco conciliado suficiente", async () => {
    const f = fixture();
    await expect(assertNegotiationSettlement(f.admin, "100", f.fresh, f.getReceipt)).resolves.toBe(true);
  });
  it("confere legado não verificado por GET e registra promoção auditada", async () => {
    const f = fixture(); f.db.fin_grupos_receber[0].integridade_status = "nao_verificado";
    await verifyNegotiationGroup(f.admin, "g1", f.getReceipt);
    expect(f.getReceipt).toHaveBeenCalledWith("100");
    expect(f.db.fin_grupos_receber[0].integridade_status).toBe("ok");
    expect(f.db.fin_audit_log[0].acao).toBe("negotiation_legacy_verified");
  });
  it("nunca promove pendência explícita mesmo com título correto", async () => {
    const f = fixture(); f.db.fin_grupos_receber[0].integridade_status = "pendente";
    await expect(verifyNegotiationGroup(f.admin, "g1", f.getReceipt)).rejects.toThrow();
    expect(f.db.fin_grupos_receber[0].integridade_status).toBe("pendente");
    expect(f.db.fin_audit_log).toHaveLength(0);
  });
  it("confere os demais títulos antes de permitir a baixa do primeiro", async () => {
    const f = fixture(); const group = f.db.fin_grupos_receber[0];
    group.valor_total = 700; group.itens_total = 2; group.os_codigos.push("9001");
    const rec = { id: "r2", gc_id: "200", grupo_id: "g1", cliente_gc_id: "client1", os_codigo: "9001", valor: 100 };
    f.db.fin_recebimentos.push(rec);
    f.db.fin_grupo_receber_itens.push({ grupo_id: "g1", recebimento_id: "r2", valor: 100, os_codigo_original: "9001", fin_recebimentos: rec });
    f.getReceipt.mockResolvedValue({ ...f.fresh, id: "200", valor_total: "101.00", descricao: "OS 9001" });
    await expect(assertNegotiationSettlement(f.admin, "100", f.fresh, f.getReceipt)).rejects.toThrow(/Valor GC/);
    expect(f.getReceipt).toHaveBeenCalledWith("200");
  });
  it.each([
    ["bloqueio financeiro", (f: ReturnType<typeof fixture>) => { f.db.fin_grupos_receber[0].bloqueio_financeiro = true; }],
    ["composição vazia", (f: ReturnType<typeof fixture>) => { f.db.fin_grupo_receber_itens = []; }],
    ["OS faltante", (f: ReturnType<typeof fixture>) => { f.db.fin_grupos_receber[0].os_codigos.push("9001"); }],
    ["soma divergente", (f: ReturnType<typeof fixture>) => { f.db.fin_grupos_receber[0].valor_total = 700; }],
    ["dois grupos para o mesmo título", (f: ReturnType<typeof fixture>) => { f.db.fin_grupo_receber_itens.push({ ...f.db.fin_grupo_receber_itens[0], grupo_id: "g2" }); }],
    ["cliente GC diferente", (f: ReturnType<typeof fixture>) => { f.fresh.cliente_id = "other"; }],
    ["identidade GC diferente", (f: ReturnType<typeof fixture>) => { f.fresh.id = "200"; }],
    ["título maior que alocação", (f: ReturnType<typeof fixture>) => { f.fresh.valor_total = "700"; }],
    ["extrato ainda não conciliado", (f: ReturnType<typeof fixture>) => { f.db.fin_extrato_lancamentos[0].fin_extrato_inter.reconciliado = false; }],
    ["facts SQL incompletos", (f: ReturnType<typeof fixture>) => { f.setIncomplete(); }],
    ["vencimento GC mudou", (f: ReturnType<typeof fixture>) => { f.db.fin_grupos_receber[0].data_vencimento = "2026-09-29"; }],
    ["valor menor sem desconto documentado", (f: ReturnType<typeof fixture>) => { f.fresh.valor_total = "599.99"; }],
    ["valor bancário insuficiente", (f: ReturnType<typeof fixture>) => { f.db.fin_extrato_lancamentos[0].valor_alocado = 599.99; }],
  ])("bloqueia %s", async (_name, mutate) => {
    const f = fixture(); mutate(f);
    await expect(assertNegotiationSettlement(f.admin, "100", f.fresh, f.getReceipt)).rejects.toThrow();
  });
});
