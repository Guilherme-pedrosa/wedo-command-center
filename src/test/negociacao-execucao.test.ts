import { describe, it, expect } from "vitest";
import { decidirConclusao } from "../../supabase/functions/_shared/job-conclusao";
import { gerarVencimentos, construirPlano, moneyToCents } from "@/lib/negociacao/planoNegociacao";

describe("conclusão de job de negociação", () => {
  it("conclui somente quando não há erro, pendência e composição está completa", () => {
    const d = decidirConclusao({ success: true, summary: { ok: 3, errors: 0 }, pendencias: [] });
    expect(d.concluiu).toBe(true);
    expect(d.okCount).toBe(3);
  });

  it("não conclui quando summary.errors > 0", () => {
    const d = decidirConclusao({ success: true, summary: { ok: 2, errors: 1 } });
    expect(d.concluiu).toBe(false);
    expect(d.motivo).toContain("erro");
  });

  it("não conclui quando success = false", () => {
    expect(decidirConclusao({ success: false, summary: { ok: 3, errors: 0 } }).concluiu).toBe(false);
  });

  it("não conclui quando há pendência de vínculo", () => {
    const d = decidirConclusao({ success: true, summary: { ok: 3, errors: 0 }, pendencias: [{ os: "9103" }] });
    expect(d.concluiu).toBe(false);
    expect(d.pendencias).toBe(1);
  });

  it("não conclui quando a composição está incompleta", () => {
    const d = decidirConclusao({ success: true, summary: { ok: 1, errors: 0 }, composicao_incompleta: true });
    expect(d.concluiu).toBe(false);
    expect(d.motivo).toContain("Composição");
  });
});

describe("vencimentos dia 31", () => {
  it("dia 31 a partir de janeiro/2026 clampa por mês", () => {
    expect(gerarVencimentos("2026-01", 31, 3)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("ano bissexto usa 29/02", () => {
    expect(gerarVencimentos("2024-01", 31, 2)).toEqual(["2024-01-31", "2024-02-29"]);
  });
});

describe("conservação em centavos", () => {
  it("saldo 600 integral em 2x300 não infla o grupo", () => {
    const plano = construirPlano({
      origens: [{ id: "os1", tipo: "os", valorOriginalCents: moneyToCents(600) }],
      valorNegociadoCents: moneyToCents(600),
      parcelas: 2,
      mesInicio: "2026-01",
      diaVencimento: 10,
    });
    expect(plano.parcelas.map((p) => p.valorCents)).toEqual([30000, 30000]);
    expect(plano.totalAlocadoCents).toBe(60000);
    expect(plano.restanteCents).toBe(0);
  });

  it("parcial 300 de 600 deixa 300 de restante e consome só 300", () => {
    const plano = construirPlano({
      origens: [{ id: "os1", tipo: "os", valorOriginalCents: moneyToCents(600) }],
      valorNegociadoCents: moneyToCents(300),
      parcelas: 1,
      mesInicio: "2026-01",
      diaVencimento: 10,
    });
    expect(plano.totalAlocadoCents).toBe(30000);
    expect(plano.restanteCents).toBe(30000);
  });
});
