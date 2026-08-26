import { describe, it, expect } from "vitest";
import {
  decidirCreditoPisCofins,
  decidirCreditoIcms,
  decidirReceitaSaida,
  apurarPisCofins,
  indexarPedidos,
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

const COM_PEDIDO = { ...NORMAL, temPedidoCompra: true };
const SEM_PEDIDO = { ...NORMAL, temPedidoCompra: false };

describe("crédito de PIS/COFINS — fornecedor do regime normal", () => {
  it("libera crédito com CST 01 destacado", () => {
    const d = decidirCreditoPisCofins(item(), NORMAL, CFOP_1102);
    expect(d.permitido).toBe(true);
    expect(d.base).toBe(1000);
    expect(d.regra).toBe("CST_TRIBUTADO");
    expect(d.viaResgateSimples).toBe(false);
  });

  it("CST 02 (alíquota diferenciada) também gera crédito", () => {
    const d = decidirCreditoPisCofins(item({ cstPis: "02", cstCofins: "02" }), NORMAL, CFOP_1102);
    expect(d.permitido).toBe(true);
  });

  it.each(["06", "07", "08", "49", "99"])(
    "CST %s sem destaque: credita quando há pedido de compra, com marca de revisão",
    (cst) => {
      const d = decidirCreditoPisCofins(
        item({ cstPis: cst, cstCofins: cst }), COM_PEDIDO, CFOP_1102,
      );
      expect(d.permitido).toBe(true);
      expect(d.base).toBe(1000);
      expect(d.regra).toBe("SEM_DESTAQUE_COM_PEDIDO");
      expect(d.requerRevisao).toBe(true);
    },
  );

  it.each(["06", "07", "08", "49", "99"])(
    "CST %s sem destaque e SEM pedido: nega",
    (cst) => {
      const d = decidirCreditoPisCofins(
        item({ cstPis: cst, cstCofins: cst }), SEM_PEDIDO, CFOP_1102,
      );
      expect(d.permitido).toBe(false);
      expect(d.regra).toBe("SEM_DESTAQUE_SEM_PEDIDO");
      expect(d.requerRevisao).toBe(true);
    },
  );

  it("sem CST mas com pedido de compra, credita", () => {
    const d = decidirCreditoPisCofins(
      item({ cstPis: null, cstCofins: null }), COM_PEDIDO, CFOP_1102,
    );
    expect(d.permitido).toBe(true);
    expect(d.regra).toBe("SEM_DESTAQUE_COM_PEDIDO");
  });

  it("normaliza CST vindo sem zero à esquerda", () => {
    const d = decidirCreditoPisCofins(item({ cstPis: "1", cstCofins: "1" }), NORMAL, CFOP_1102);
    expect(d.permitido).toBe(true);
    expect(d.regra).toBe("CST_TRIBUTADO");
  });

  it("Lucro Presumido credita a nossa alíquota cheia, não a cumulativa dele", () => {
    // CRT 3 abrange Lucro Real e Presumido. O adquirente no não-cumulativo
    // credita 9,25% sobre o valor da aquisição, não os 3,65% que o
    // fornecedor recolheu.
    const d = decidirCreditoPisCofins(item({ valorProduto: 10_000 }), NORMAL, CFOP_1102);
    expect(d.permitido).toBe(true);
    expect(d.base).toBe(10_000);
    const { pis, cofins } = apurarPisCofins({
      receitaBruta: 0, baseDebito: 0, baseCredito: d.base, baseCreditoSimples: 0,
      retencaoPis: 0, retencaoCofins: 0,
      saldoCredorAnteriorPis: 0, saldoCredorAnteriorCofins: 0,
    });
    expect(pis.valorCredito + cofins.valorCredito).toBe(925);
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

  it("respeita o CFOP: remessa não gera crédito nem no Simples", () => {
    const d = decidirCreditoPisCofins(
      item({ cfop: "1556", cstPis: "49", cstCofins: "49" }),
      SIMPLES,
      CFOP_1556,
    );
    expect(d.permitido).toBe(false);
    expect(d.regra).toBe("CFOP_NAO_AQUISICAO");
  });

  it("MEI segue a mesma regra do Simples", () => {
    const d = decidirCreditoPisCofins(item({ cstPis: "49" }), MEI, CFOP_1102);
    expect(d.permitido).toBe(true);
    expect(d.viaResgateSimples).toBe(true);
  });

  it("CRT ausente com pedido de compra ainda credita", () => {
    const d = decidirCreditoPisCofins(
      item({ cstPis: "49" }),
      { ...SEM_CRT, temPedidoCompra: true },
      CFOP_1102,
    );
    expect(d.permitido).toBe(true);
    expect(d.requerRevisao).toBe(true);
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

describe("serviço tomado — insumo depende da natureza, não do CFOP", () => {
  const servico = (over: Partial<ItemEntrada> = {}): ItemEntrada =>
    item({ cfop: "5933", ehServico: true, cstPis: "01", cstCofins: "01", ...over });
  const CFOP_5933: RegraCfop = {
    cfop: "5933", sentido: "saida", compoeReceita: true,
    geraCreditoPisCofins: true, geraCreditoIcms: false,
  };

  it("manutenção de equipamento credita", () => {
    const d = decidirCreditoPisCofins(
      servico({ servicoEhInsumo: true, servicoCategoria: "manutencao" }), NORMAL, CFOP_5933,
    );
    expect(d.permitido).toBe(true);
    expect(d.regra).toBe("SERVICO_INSUMO");
  });

  it("alimentação NÃO credita mesmo com CST 01 e fornecedor do Simples", () => {
    const d = decidirCreditoPisCofins(
      servico({ servicoEhInsumo: false, servicoCategoria: "alimentacao" }),
      { ...SIMPLES, temPedidoCompra: true },
      CFOP_5933,
    );
    expect(d.permitido).toBe(false);
    expect(d.regra).toBe("SERVICO_NAO_INSUMO");
  });

  it("comissão de venda não credita nem com pedido de compra", () => {
    const d = decidirCreditoPisCofins(
      servico({ servicoEhInsumo: false, servicoCategoria: "comissao_venda" }),
      COM_PEDIDO, CFOP_5933,
    );
    expect(d.permitido).toBe(false);
  });

  it("serviço sem descrição classificável não credita e pede revisão", () => {
    const d = decidirCreditoPisCofins(
      servico({ servicoEhInsumo: null, nomeProduto: "mensal" }), COM_PEDIDO, CFOP_5933,
    );
    expect(d.permitido).toBe(false);
    expect(d.regra).toBe("SERVICO_INDECIDIVEL");
    expect(d.requerRevisao).toBe(true);
  });
});

describe("MEI e pessoa física", () => {
  it("MEI tem CNPJ, é pessoa jurídica, e credita como o Simples", () => {
    const d = decidirCreditoPisCofins(item({ cstPis: "49" }), MEI, CFOP_1102);
    expect(d.permitido).toBe(true);
    expect(d.viaResgateSimples).toBe(true);
  });

  it("emitente pessoa física (CPF) não gera crédito", () => {
    const d = decidirCreditoPisCofins(
      item(), { ...NORMAL, emitentePessoaFisica: true }, CFOP_1102,
    );
    expect(d.permitido).toBe(false);
    expect(d.regra).toBe("PESSOA_FISICA");
  });
});

describe("saldo credor: PIS e COFINS não se comunicam", () => {
  // Lei 10.833/2003 art. 3º, §4º deixa o crédito não aproveitado passar para os
  // meses seguintes -- mas cada contribuição tem o seu. Crédito de PIS não
  // abate COFINS: são códigos de receita diferentes no DARF. A tela chegou a
  // somar os dois numa coluna só, o que escondia exatamente isso.
  const base = {
    baseDebito: 100_000,
    baseCredito: 0,
    baseCreditoSimples: 0,
    retencaoPis: 0,
    retencaoCofins: 0,
    saldoCredorAnteriorPis: 0,
    saldoCredorAnteriorCofins: 0,
  };

  it("credor sobrando no PIS não reduz o débito de COFINS", () => {
    const r = apurarPisCofins({ ...base, saldoCredorAnteriorPis: 50_000 });

    // PIS: 1,65% de 100k = 1.650, contra 50.000 de credor -> zera e sobra.
    expect(r.pis.saldoARecolher).toBe(0);
    expect(r.pis.saldoCredorProximo).toBe(48_350);

    // COFINS: 7,6% de 100k = 7.600, intocado pelo credor de PIS.
    expect(r.cofins.saldoARecolher).toBe(7_600);
    expect(r.cofins.saldoCredorProximo).toBe(0);
  });

  it("cada contribuição consome só o seu saldo do mês anterior", () => {
    const r = apurarPisCofins({
      ...base,
      saldoCredorAnteriorPis: 1_000,
      saldoCredorAnteriorCofins: 2_000,
    });

    expect(r.pis.saldoARecolher).toBe(650); // 1.650 - 1.000
    expect(r.cofins.saldoARecolher).toBe(5_600); // 7.600 - 2.000
    expect(r.saldoTotalARecolher).toBe(6_250);
  });

  it("crédito não aproveitado é transportado, não perdido", () => {
    const r = apurarPisCofins({ ...base, baseCredito: 300_000 });

    // Crédito de 300k contra débito de 100k: sobra base de 200k em cada.
    expect(r.pis.saldoARecolher).toBe(0);
    expect(r.cofins.saldoARecolher).toBe(0);
    expect(r.pis.saldoCredorProximo).toBe(3_300); // 1,65% de 200k
    expect(r.cofins.saldoCredorProximo).toBe(15_200); // 7,6% de 200k
  });
});

describe("amarração pedido de compra ↔ nota fiscal", () => {
  // Casos tirados da base real da WeDo. Casar só pelo número da NF dava 291
  // notas (R$ 387 mil) herdando pedido de outro fornecedor, e calava o alerta
  // de compra sem XML em 99,7% dos casos.
  const nota = (numero: string, cnpj: string, nome: string) => ({
    numero,
    cnpjEmitente: cnpj,
    nomeEmitente: nome,
  });
  const pedido = (numeroNfe: string, cnpj: string | null, nome: string) => ({
    numeroNfe,
    cnpjFornecedor: cnpj,
    nomeFornecedor: nome,
  });

  it("não deixa uma nota herdar o pedido de outro fornecedor", () => {
    const ix = indexarPedidos([pedido("20", "56914804000150", "FRED JORGE DANTAS")]);
    expect(ix.temPedido(nota("20", "64350009000105", "Wilton Rosa Silva"))).toBe(false);
  });

  it("casa pelo CNPJ mesmo com zeros à esquerda de um lado só", () => {
    const ix = indexarPedidos([pedido("000020", "64350009000105", "Wilton Rosa Silva")]);
    expect(ix.temPedido(nota("20", "64350009000105", "WILTON ROSA SILVA"))).toBe(true);
  });

  it("casa matriz com filial pela raiz do CNPJ", () => {
    // O pedido fica no CNPJ da matriz e a nota sai da filial. É o mesmo
    // fornecedor -- comparar os 14 dígitos separava um só.
    const ix = indexarPedidos([pedido("60837", "12345678000199", "Nova Milenio")]);
    expect(ix.temPedido(nota("60837", "12345678000288", "Nova Milenio"))).toBe(true);
  });

  it("aceita o CNPJ que o ERP cola na frente do nome quando o campo vem vazio", () => {
    // 10,6% dos pedidos do Gestão Click não têm cnpj_fornecedor preenchido,
    // mas trazem "62.197.586 AYRTON EULER..." na razão social.
    const ix = indexarPedidos([pedido("62", null, "62.197.586 AYRTON EULER DOS SANTOS")]);
    expect(ix.temPedido(nota("62", "62197586000183", "AYRTON EULER DOS SANTOS CARVALHO"))).toBe(
      true,
    );
  });

  it("casa por nome quando nenhum dos dois lados tem CNPJ utilizável", () => {
    const ix = indexarPedidos([pedido("777", null, "Paulinélis Transportes Ltda")]);
    expect(ix.temPedido(nota("777", "", "PAULINELIS TRANSPORTES LTDA"))).toBe(true);
  });

  it("não casa quando o cadastro diverge de verdade", () => {
    // "PAULINELIS" na nota, "PAULINERIS" no pedido: erro de digitação real.
    // Preferimos deixar sem casar a inventar equivalência por semelhança.
    const ix = indexarPedidos([pedido("680217", null, "PAULINERIS TRANSPORTES")]);
    expect(ix.temPedido(nota("680217", "11222333000144", "PAULINELIS TRANSPORTES"))).toBe(false);
  });

  it("lista como sem XML só o pedido cuja própria nota falta", () => {
    const ix = indexarPedidos([
      pedido("100", "11111111000191", "Fornecedor A"),
      pedido("100", "22222222000172", "Fornecedor B"),
    ]);
    // Chegou o XML do A. O do B continua faltando -- e antes o XML do A
    // servia de álibi para os dois, porque o número era o mesmo.
    const faltam = ix.semNota([nota("100", "11111111000191", "Fornecedor A")]);
    expect(faltam.map((p) => p.nomeFornecedor)).toEqual(["Fornecedor B"]);
  });

  it("ignora pedido sem número de nota informado", () => {
    const ix = indexarPedidos([pedido("", "11111111000191", "Fornecedor A")]);
    expect(ix.semNota([])).toEqual([]);
  });
});
