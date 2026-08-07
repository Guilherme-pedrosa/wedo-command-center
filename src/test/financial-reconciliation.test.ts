import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isGcSettled } from "@/lib/financial-reconciliation";

const root = process.cwd();

describe("integridade da conciliação financeira", () => {
  it("considera a liquidação sincronizada do GC como baixa confirmada", () => {
    expect(isGcSettled({ gc_baixado: true, liquidado: false, status: "pendente" })).toBe(true);
    expect(isGcSettled({ gc_baixado: false, liquidado: true, status: "pendente" })).toBe(true);
    expect(isGcSettled({ gc_baixado: false, liquidado: false, status: "pago" })).toBe(true);
    expect(isGcSettled({ gc_baixado: false, liquidado: false, status: "pendente" })).toBe(false);
  });

  it("protege a gravação com lock e limite de alocação", () => {
    const migration = readFileSync(resolve(root, "supabase/migrations/20260807162500_atomic_financial_reconciliation.sql"), "utf8");
    expect(migration).toContain("fin_reconcile_extrato_atomic");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("v_alocado_antes + v_valor_alocado > v_valor_titulo + 0.02");
    expect(migration).toContain("trg_validate_fin_extrato_allocation");
    expect(migration).toContain("fin_undo_reconcile_extrato_atomic");
  });

  it("não mantém o corte silencioso de 3.000 candidatos no motor", () => {
    const engine = readFileSync(resolve(root, "supabase/functions/reconciliation-engine/index.ts"), "utf8");
    expect(engine).toContain("fetchEverySupabaseRow");
    expect(engine).toContain('rpc("fin_reconcile_extrato_atomic"');
    expect(engine).not.toContain(".limit(3000)");
  });

  it("continua automaticamente uma importação parcial do Inter", () => {
    const api = readFileSync(resolve(root, "src/api/financeiro.ts"), "utf8");
    expect(api).toContain("while (cursor <= dataFim && runs < 24)");
    expect(api).toContain("current.truncado");
    expect(api).toContain("current?.proximo_periodo?.dataInicio");
  });
});
