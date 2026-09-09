import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  construirPlano,
  gerarVencimentos,
  identificarTitulo,
  validarPlano,
  moneyToCents,
} from "@/lib/negociacao/planoNegociacao";

const os = (id: string, valor: number, pago = 0) => ({
  id,
  tipo: "os" as const,
  codigo: id,
  valorCents: moneyToCents(valor),
  pagoCents: moneyToCents(pago),
});

const residuo = (id: string, valor: number) => ({
  id,
  tipo: "residuo" as const,
  codigo: id,
  valorCents: moneyToCents(valor),
});

describe("motor de plano da negociação", () => {
  it("saldo 600 integral em 2x300 não cria grupo de 900", () => {
    const plano = construirPlano({
      origens: [os("OS1", 600)],
      parcelas: 2,
      diaVencimento: 10,
      mesInicio: "2026-01",
    });
    expect(plano.valido).toBe(true);
    expect(plano.totalNegociadoCents).toBe(60000);
    expect(plano.parcelas.map((p) => p.valorCents)).toEqual([30000, 30000]);
    expect(plano.totalRestanteCents).toBe(0);
  });

  it("parcial de 300 sobre 600 deixa 300 de restante e consome só 300", () => {
    const plano = construirPlano({
      origens: [os("OS1", 600)],
      parcelas: 1,
      diaVencimento: 10,
      mesInicio: "2026-01",
      montanteNegociadoCents: moneyToCents(300),
    });
    expect(plano.valido).toBe(true);
    expect(plano.totalNegociadoCents).toBe(30000);
    expect(plano.parcelas[0].valorCents).toBe(30000);
    expect(plano.totalRestanteCents).toBe(30000);
    expect(plano.alocacoes[0]).toMatchObject({ alocadoCents: 30000, restanteCents: 30000 });
  });

  it("OS + resíduos conservam o total e o resíduo não fica todo na 1ª parcela", () => {
    const plano = construirPlano({
      origens: [os("OS1", 1000), residuo("R1", 500)],
      parcelas: 3,
      diaVencimento: 15,
      mesInicio: "2026-03",
    });
    expect(plano.valido).toBe(true);
    expect(plano.totalNegociadoCents).toBe(150000);
    const somaComposicao = plano.parcelas.reduce(
      (s, p) => s + p.composicao.reduce((a, c) => a + c.valorCents, 0),
      0
    );
    expect(somaComposicao).toBe(150000);
    const parcelasComResiduo = plano.parcelas.filter((p) =>
      p.composicao.some((c) => c.origemId === "R1")
    );
    expect(parcelasComResiduo.length).toBeGreaterThan(1);
  });

  it("origem já paga parcialmente entra apenas com o saldo", () => {
    const plano = construirPlano({
      origens: [os("OS1", 1000, 400)],
      parcelas: 2,
      diaVencimento: 5,
      mesInicio: "2026-02",
    });
    expect(plano.totalOrigensCents).toBe(60000);
    expect(plano.totalNegociadoCents).toBe(60000);
    expect(validarPlano(plano)).toHaveLength(0);
  });

  it("recusa montante acima do saldo e origem de outro cliente", () => {
    const plano = construirPlano({
      origens: [{ ...os("OS1", 100), clienteGcId: "999" }],
      parcelas: 1,
      diaVencimento: 10,
      mesInicio: "2026-01",
      montanteNegociadoCents: moneyToCents(500),
      clienteGcId: "111",
    });
    expect(plano.valido).toBe(false);
    expect(plano.pendencias.map((p) => p.codigo)).toContain("montante_acima_do_saldo");
    expect(plano.pendencias.map((p) => p.codigo)).toContain("origem_outro_cliente");
  });

  it("parcelas manuais que não somam geram pendência explícita", () => {
    const plano = construirPlano({
      origens: [os("OS1", 600)],
      parcelas: 2,
      diaVencimento: 10,
      mesInicio: "2026-01",
      valoresParcelasCents: [moneyToCents(400), moneyToCents(400)],
    });
    expect(plano.valido).toBe(false);
    expect(plano.pendencias.map((p) => p.codigo)).toContain("parcelas_nao_somam");
  });

  it("dia 31 respeita meses curtos e ano bissexto", () => {
    expect(gerarVencimentos("2026-01", 31, 3)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(gerarVencimentos("2028-01", 31, 2)).toEqual(["2028-01-31", "2028-02-29"]);
    expect(gerarVencimentos("2026-11", 31, 3)).toEqual(["2026-11-30", "2026-12-31", "2027-01-31"]);
  });

  it("centavos indivisíveis fecham exatamente", () => {
    const plano = construirPlano({
      origens: [os("OS1", 100.01), residuo("R1", 0.02)],
      parcelas: 3,
      diaVencimento: 20,
      mesInicio: "2026-05",
    });
    expect(plano.valido).toBe(true);
    expect(plano.parcelas.reduce((s, p) => s + p.valorCents, 0)).toBe(10003);
  });
});

describe("identidade de título", () => {
  const base = { clienteGcId: "111", valorCents: 30000, dataVencimento: "2026-01-31" };

  it("título de outra OS com mesmo valor e data não associa", () => {
    const r = identificarTitulo(
      { ...base, osCodigo: "8779" },
      [{ gcId: "1", descricao: "NEG96 - Parcela 1/2 - OS 9999", ...base }]
    );
    expect(r.gcId).toBeNull();
    expect(r.pendencia?.codigo).toBe("titulo_nao_identificado");
  });

  it("dois candidatos param e registram pendência", () => {
    const r = identificarTitulo(
      { ...base, osCodigo: "8779" },
      [
        { gcId: "1", descricao: "NEG96 - Parcela 1/2 - OS 8779", ...base },
        { gcId: "2", descricao: "NEG96 - Parcela 2/2 - OS 8779", ...base },
      ]
    );
    expect(r.gcId).toBeNull();
    expect(r.pendencia?.codigo).toBe("titulo_ambiguo");
  });

  it("passivo com valor igual à parcela não é confundido com a parcela", () => {
    const candidatos = [
      { gcId: "1", descricao: "NEG96 - Parcela 1/2 - OS 8779", ...base, parcelaNumero: 1 },
      { gcId: "2", descricao: "NEG96 - Passivo - OS 8779", ...base, parcelaNumero: null },
    ];
    const parcela = identificarTitulo({ ...base, osCodigo: "8779", parcelaNumero: 1 }, candidatos);
    expect(parcela.gcId).toBe("1");
  });

  it("associa quando há candidato único e coerente", () => {
    const r = identificarTitulo(
      { ...base, osCodigo: "8779", negociacaoNumero: 96 },
      [{ gcId: "7", descricao: "NEG96 - Parcela 1/2 - OS 8779", negociacaoNumero: 96, ...base }]
    );
    expect(r.gcId).toBe("7");
  });
});

describe("motor compartilhado", () => {
  it("cópia do servidor está idêntica à do frontend", () => {
    const front = fs.readFileSync(path.resolve("src/lib/negociacao/planoNegociacao.ts"), "utf8");
    const back = fs.readFileSync(path.resolve("supabase/functions/_shared/negociacao-plano.ts"), "utf8");
    expect(back).toBe(front);
  });
});
