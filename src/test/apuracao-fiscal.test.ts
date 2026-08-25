import { describe, it, expect } from "vitest";
import {
  decidirCreditoPisCofins,
  decidirCreditoIcms,
  decidirReceitaSaida,
  apurarPisCofins,
  apurarIcms,
  ratearRetencoes,
  round2,
  type ItemEntrada,
  type NotaSaida,
  type RegraCfop,
} from "@/lib/apuracaoFiscal";

const CFOP_1102: RegraCfop = {
  cfop: "1102",
  sentido: "entrada",
  compoeReceita: false,
  geraCreditoPisCofins: true,
  geraCreditoIcms: true,
};

const CFOP_1556: RegraCfop = {
  cfop: "1556",
  sentido: "entrada",
  compoeReceita: false,
  geraCreditoPisCofins: false,
  geraCreditoIcms: false,
};

const CFOP_5102: RegraCfop = {
  cfop: "5102",
  sentido: "saida",
  compoeReceita: true,
  geraCreditoPisCofins: false,
  geraCreditoIcms: false,
};

const CFOP_5202: RegraCfop = {
  cfop: "5202",
  sentido: "saida",
  compoeReceita: false,
  geraCreditoPisCofins: false,
  geraCreditoIcms: false,
};

function item(over: Partial<ItemEntrada> = {}): ItemEntrada {
  return {
    ordem: 1,
    cfop: "1102",
    cstPis: "01",
    cstCofins: "01",
    cstIcms: "00",
    valorProduto: 1000,
    valorDesconto: 0,
    valorFrete: 100,
    valorIcms: 180,
    ...over,
  };
}

const NORMAL = { regimeEmitente: "regime_normal" as const, crtEmitente: 3 };
const SIMPLES = { regimeEmitente: "simples_nacional" as const, crtEmitente: 1 };
const MEI = { regimeEmitente: "mei" as const, crtEmitente: 4 };
const SEM_CRT = { regimeEmitente: "desconhecido" as const, crtEmitente: null };

describe("Regra 2.3 — crédito por CST (fornecedor regime normal)", () => {
  it("libera crédito com CST 01", () => {
    const d = decidirCreditoPisCofins(item(), NORMAL, CFOP_1102);
    expect(d.permitido).toBe(true);
    expect(d.base).toBe(1000);
    expect(d.regra).toBe("CST_01");
    expect(d.viaResgateSimples).toBe(false);
  });

  it.each(["02", "06", "07", "08", "49", "99"])(
    "bloqueia CST %s",
    (cst) => {
      const d = decidirCreditoPisCofins(item({ cstPis: cst, cstCofins: cst }), NORMAL, CFOP_1102);
      expect(d.permitido).toBe(false);
      expect(d.base).toBe(0);
      expect(d.regra).toBe("CST_BLOQUEADO");
    },
  );

  it("não decide sem CST e marca para revisão", () => {
    const d = decidirCreditoPisCofins(
      item({ cstPis: null, cstCofins: null }),
      NORMAL,
      CFOP_1102,
    );
    expect(d.permitido).toBe(false);
    expect(d.requerRevisao).toBe(true);
    expect(d.regra).toBe("CST_AUSENTE");
  });

  it("normaliza CST vindo sem zero à esquerda", () => {
    const d = decidirCreditoPisCofins(item({ cstPis: "1", cstCofins: "1" }), NORMAL, CFOP_1102);
    expect(d.permitido).toBe(true);
    expect(d.regra).toBe("CST_01");
  });
});

describe("Regra 2.4 — resgate do Simples Nacional", () => {
  it("libera crédito ignorando CST 49", () => {
    const d = decidirCreditoPisCofins(
      item({ cstPis: "49", cstCofins: "49" }),
      SIMPLES,
      CFOP_1102,
    );
    expect(d.permitido).toBe(true);
    expect(d.base).toBe(1000);
    expect(d.viaResgateSimples).toBe(true);
    expect(d.regra).toBe("RESGATE_SIMPLES");
  });

  it("libera mesmo sem CST informado", () => {
    const d = decidirCreditoPisCofins(
      item({ cstPis: null, cstCofins: null }),
      SIMPLES,
      CFOP_1102,
    );
    expect(d.permitido).toBe(true);
    expect(d.viaResgateSimples).toBe(true);
  });

  it.each(["04", "05"])(
    "NÃO resgata CST %s (monofásico/ST) — vedação absoluta",
    (cst) => {
      const d = decidirCreditoPisCofins(
        item({ cstPis: cst, cstCofins: cst }),
        SIMPLES,
        CFOP_1102,
      );
      expect(d.permitido).toBe(false);
      expect(d.regra).toBe("CST_MONOFASICO_ST");
    },
  );

  it("respeita o CFOP: uso e consumo não gera crédito nem no Simples", () => {
    const d = decidirCreditoPisCofins(
      item({ cfop: "1556", cstPis: "49", cstCofins: "49" }),
      SIMPLES,
      CFOP_1556,
    );
    expect(d.permitido).toBe(false);
    expect(d.regra).toBe("CFOP_SEM_CREDITO");
  });

  it("MEI não é decidido automaticamente", () => {
    const d = decidirCreditoPisCofins(item({ cstPis: "49" }), MEI, CFOP_1102);
    expect(d.permitido).toBe(false);
    expect(d.requerRevisao).toBe(true);
    expect(d.regra).toBe("MEI_REVISAR");
  });

  it("CRT ausente não vira suposição", () => {
    const d = decidirCreditoPisCofins(item({ cstPis: "49" }), SEM_CRT, CFOP_1102);
    expect(d.permitido).toBe(false);
    expect(d.requerRevisao).toBe(true);
    expect(d.regra).toBe("CRT_AUSENTE");
  });
});

describe("base do crédito", () => {
  it("desconta abatimentos e ignora frete por padrão", () => {
    const d = decidirCreditoPisCofins(
      item({ valorProduto: 1000, valorDesconto: 50, valorFrete: 100 }),
      NORMAL,
      CFOP_1102,
    );
    expect(d.base).toBe(950);
  });

  it("inclui frete quando explicitamente ligado", () => {
    const d = decidirCreditoPisCofins(
      item({ valorProduto: 1000, valorDesconto: 50, valorFrete: 100 }),
      NORMAL,
      CFOP_1102,
      { incluirFrete: true },
    );
    expect(d.base).toBe(1050);
  });

  it("CFOP não cadastrado marca revisão em vez de assumir", () => {
    const d = decidirCreditoPisCofins(item({ cfop: "1949" }), NORMAL, null);
    expect(d.permitido).toBe(false);
    expect(d.requerRevisao).toBe(true);
    expect(d.regra).toBe("CFOP_NAO_CADASTRADO");
  });
});

describe("crédito de ICMS", () => {
  it("credita o ICMS destacado de fornecedor do regime normal", () => {
    const d = decidirCreditoIcms(item(), NORMAL, CFOP_1102);
    expect(d.permitido).toBe(true);
    expect(d.base).toBe(180);
  });

  it("Simples não transfere crédito de ICMS", () => {
    const d = decidirCreditoIcms(item(), SIMPLES, CFOP_1102);
    expect(d.permitido).toBe(false);
    expect(d.regra).toBe("SIMPLES_SEM_ICMS");
  });

  it("sem destaque não há crédito", () => {
    const d = decidirCreditoIcms(item({ valorIcms: 0 }), NORMAL, CFOP_1102);
    expect(d.permitido).toBe(false);
    expect(d.regra).toBe("ICMS_SEM_DESTAQUE");
  });
});

describe("Regra 1 — base de débito", () => {
  function saida(over: Partial<NotaSaida> = {}): NotaSaida {
    return {
      gcId: "1",
      modelo: "55",
      autorizada: true,
      cancelada: false,
      denegada: false,
      codigoCfop: "5102",
      valorProdutos: 5000,
      valorServico: 0,
      valorDesconto: 0,
      ...over,
    };
  }

  it("inclui venda autorizada", () => {
    const d = decidirReceitaSaida(saida(), CFOP_5102);
    expect(d.compoe).toBe(true);
    expect(d.valor).toBe(5000);
  });

  it("exclui cancelada e denegada", () => {
    expect(decidirReceitaSaida(saida({ cancelada: true }), CFOP_5102).compoe).toBe(false);
    expect(decidirReceitaSaida(saida({ denegada: true }), CFOP_5102).compoe).toBe(false);
  });

  it("expurga devolução de compra pelo CFOP", () => {
    const d = decidirReceitaSaida(saida({ codigoCfop: "5202" }), CFOP_5202);
    expect(d.compoe).toBe(false);
    expect(d.motivo).toContain("Regra 1.3");
  });

  it("expurga NFS-e de bonificação pela natureza da operação", () => {
    const d = decidirReceitaSaida(
      saida({
        modelo: "NFSE",
        codigoCfop: null,
        valorProdutos: 0,
        valorServico: 800,
        naturezaOperacao: "Remessa em bonificação",
      }),
      null,
    );
    expect(d.compoe).toBe(false);
  });

  it("inclui NFS-e comum", () => {
    const d = decidirReceitaSaida(
      saida({
        modelo: "NFSE",
        codigoCfop: null,
        valorProdutos: 0,
        valorServico: 800,
        naturezaOperacao: "Prestação de serviço",
      }),
      null,
    );
    expect(d.compoe).toBe(true);
    expect(d.valor).toBe(800);
  });

  it("nota não autorizada fica fora e pede revisão", () => {
    const d = decidirReceitaSaida(saida({ autorizada: false }), CFOP_5102);
    expect(d.compoe).toBe(false);
    expect(d.requerRevisao).toBe(true);
  });

  it("abate desconto da base", () => {
    const d = decidirReceitaSaida(saida({ valorDesconto: 500 }), CFOP_5102);
    expect(d.valor).toBe(4500);
  });
});

describe("consolidação PIS/COFINS", () => {
  const base = {
    receitaBruta: 100_000,
    baseDebito: 100_000,
    baseCredito: 40_000,
    baseCreditoSimples: 10_000,
    retencaoPis: 0,
    retencaoCofins: 0,
    saldoCredorAnteriorPis: 0,
    saldoCredorAnteriorCofins: 0,
  };

  it("aplica as alíquotas separadamente", () => {
    const { pis, cofins } = apurarPisCofins(base);
    expect(pis.valorDebito).toBe(1650);
    expect(pis.valorCredito).toBe(660);
    expect(pis.saldoARecolher).toBe(990);
    expect(cofins.valorDebito).toBe(7600);
    expect(cofins.valorCredito).toBe(3040);
    expect(cofins.saldoARecolher).toBe(4560);
  });

  it("retenção reduz a guia", () => {
    const { pis } = apurarPisCofins({ ...base, retencaoPis: 500 });
    expect(pis.saldoARecolher).toBe(490);
  });

  it("crédito maior que débito vira saldo credor, nunca guia negativa", () => {
    const { pis } = apurarPisCofins({ ...base, baseCredito: 200_000 });
    expect(pis.saldoARecolher).toBe(0);
    expect(pis.saldoCredorProximo).toBe(1650);
  });

  it("saldo credor anterior é absorvido", () => {
    const { pis } = apurarPisCofins({ ...base, saldoCredorAnteriorPis: 300 });
    expect(pis.saldoARecolher).toBe(690);
  });

  it("soma as duas guias", () => {
    const { saldoTotalARecolher } = apurarPisCofins(base);
    expect(saldoTotalARecolher).toBe(5550);
  });
});

describe("apuração de ICMS", () => {
  it("confronta débito e crédito destacados", () => {
    const r = apurarIcms({ debitoDestacado: 9000, creditoDestacado: 3500, saldoCredorAnterior: 0 });
    expect(r.saldoARecolher).toBe(5500);
  });

  it("crédito excedente vira saldo credor", () => {
    const r = apurarIcms({ debitoDestacado: 1000, creditoDestacado: 2500, saldoCredorAnterior: 0 });
    expect(r.saldoARecolher).toBe(0);
    expect(r.saldoCredorProximo).toBe(1500);
  });
});

describe("arredondamento", () => {
  it("arredonda meio para cima em 2 casas", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(1234.5649)).toBe(1234.56);
  });

  it("não propaga erro de ponto flutuante na alíquota", () => {
    const { pis } = apurarPisCofins({
      receitaBruta: 333.33,
      baseDebito: 333.33,
      baseCredito: 0,
      baseCreditoSimples: 0,
      retencaoPis: 0,
      retencaoCofins: 0,
      saldoCredorAnteriorPis: 0,
      saldoCredorAnteriorCofins: 0,
    });
    expect(pis.valorDebito).toBe(5.5);
  });
});

describe("Regra 3 — rateio de retenções por liquidação", () => {
  const nota = {
    nfSaidaId: "nf-1",
    numero: "500",
    valorTotalNf: 10_000,
    valorPisRetido: 65,
    valorCofinsRetido: 300,
  };

  it("retém integral quando a nota é paga de uma vez", () => {
    const r = ratearRetencoes(
      [nota],
      [{ recebimentoId: "r1", nfNumero: "500", valor: 10_000, dataLiquidacao: "2026-07-10" }],
    );
    expect(r.totalPis).toBe(65);
    expect(r.totalCofins).toBe(300);
    expect(r.retencoes).toHaveLength(1);
  });

  it("rateia proporcionalmente em pagamento parcial", () => {
    const r = ratearRetencoes(
      [nota],
      [{ recebimentoId: "r1", nfNumero: "500", valor: 4_000, dataLiquidacao: "2026-07-10" }],
    );
    expect(r.retencoes[0].proporcao).toBeCloseTo(0.4);
    expect(r.totalPis).toBe(26);
    expect(r.totalCofins).toBe(120);
  });

  it("duas parcelas na mesma competência somam o total", () => {
    const r = ratearRetencoes(
      [nota],
      [
        { recebimentoId: "r1", nfNumero: "500", valor: 6_000, dataLiquidacao: "2026-07-10" },
        { recebimentoId: "r2", nfNumero: "500", valor: 4_000, dataLiquidacao: "2026-07-25" },
      ],
    );
    expect(r.totalPis).toBe(65);
    expect(r.totalCofins).toBe(300);
  });

  it("nunca rateia mais que 100% da retenção da nota", () => {
    const r = ratearRetencoes(
      [nota],
      [
        { recebimentoId: "r1", nfNumero: "500", valor: 9_000, dataLiquidacao: "2026-07-10" },
        { recebimentoId: "r2", nfNumero: "500", valor: 9_000, dataLiquidacao: "2026-07-25" },
      ],
    );
    expect(r.totalPis).toBeLessThanOrEqual(65);
    expect(r.totalCofins).toBeLessThanOrEqual(300);
    expect(r.avisos.some((a) => a.tipo === "LIQUIDACAO_EXCEDE_NOTA")).toBe(true);
  });

  it("ignora recebimento sem NFS-e correspondente", () => {
    const r = ratearRetencoes(
      [nota],
      [{ recebimentoId: "r1", nfNumero: "999", valor: 1_000, dataLiquidacao: "2026-07-10" }],
    );
    expect(r.retencoes).toHaveLength(0);
    expect(r.totalPis).toBe(0);
  });

  it("ignora nota sem retenção declarada", () => {
    const semRetencao = { ...nota, valorPisRetido: 0, valorCofinsRetido: 0 };
    const r = ratearRetencoes(
      [semRetencao],
      [{ recebimentoId: "r1", nfNumero: "500", valor: 10_000, dataLiquidacao: "2026-07-10" }],
    );
    expect(r.retencoes).toHaveLength(0);
  });

  it("avisa quando a nota tem retenção mas valor zero", () => {
    const invalida = { ...nota, valorTotalNf: 0 };
    const r = ratearRetencoes(
      [invalida],
      [{ recebimentoId: "r1", nfNumero: "500", valor: 500, dataLiquidacao: "2026-07-10" }],
    );
    expect(r.retencoes).toHaveLength(0);
    expect(r.avisos[0].tipo).toBe("NFSE_SEM_VALOR");
  });
});
