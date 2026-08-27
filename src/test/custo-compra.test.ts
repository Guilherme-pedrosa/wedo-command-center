import { describe, it, expect } from "vitest";
import { custoComDescontoDaNf, fatorDescontoNf } from "@/lib/custoCompra";

/**
 * Casos tirados da base real da WeDo. O pedido de compra do Gestão Click
 * guarda o preço de tabela e o desconto só existe na nota: dos 1.137 pedidos
 * de 2026, nenhum tem o campo de desconto preenchido, e em 99 dos 124 itens
 * com desconto o custo do pedido era idêntico ao bruto da nota.
 */
describe("desconto da nota sobre o custo do pedido", () => {
  const compra = { compra_gc_id: "555" };

  it("aplica o desconto quando o pedido veio com o preço de tabela", () => {
    // Globalvac NF 34468: máquina de embalar a vácuo tabelada em R$ 27.000,
    // com R$ 10.530 de desconto. A nota cobrou R$ 16.470.
    const custo = custoComDescontoDaNf(
      27000,
      { compra_gc_id: "555", v_desc: 10530, v_un_com: 27000, q_com: 1, valor_unitario_nf: 16470 },
      compra,
    );
    expect(custo).toBeCloseTo(16470, 2);
  });

  it("rateia o desconto por quantidade, não por item", () => {
    // NF 34882: 4 seladoras a R$ 970, desconto de R$ 1.513,20 no total.
    // O unitário líquido é R$ 591,70 — dividir o desconto pelo item em vez de
    // pela quantidade daria R$ 0 negativo.
    const custo = custoComDescontoDaNf(
      970,
      { compra_gc_id: "555", v_desc: 1513.2, v_un_com: 970, q_com: 4, valor_unitario_nf: 591.7 },
      compra,
    );
    expect(custo).toBeCloseTo(591.7, 2);
  });

  it("não desconta duas vezes quando o pedido já veio líquido", () => {
    // 3 dos 124 itens chegam assim. Aplicar o fator de novo cobraria o
    // desconto em dobro e derrubaria o preço de venda abaixo do custo.
    const custo = custoComDescontoDaNf(
      16470,
      { compra_gc_id: "555", v_desc: 10530, v_un_com: 27000, q_com: 1, valor_unitario_nf: 16470 },
      compra,
    );
    expect(custo).toBe(16470);
  });

  it("ignora desconto de nota que é de outra compra", () => {
    const custo = custoComDescontoDaNf(
      27000,
      { compra_gc_id: "999", v_desc: 10530, v_un_com: 27000, q_com: 1, valor_unitario_nf: 16470 },
      compra,
    );
    expect(custo).toBe(27000);
  });

  it("é razão, então atravessa divergência de unidade entre pedido e nota", () => {
    // ITW FEG NF 131273: pedido a R$ 3.428,57, bruto da nota R$ 3.057,30 —
    // bases diferentes (embalagem/kit). O desconto de 20% ainda tem de sair.
    const custo = custoComDescontoDaNf(
      3428.57,
      { compra_gc_id: "555", v_desc: 611.46, v_un_com: 3057.3, q_com: 1, valor_unitario_nf: 2445.84 },
      compra,
    );
    expect(custo).toBeCloseTo(3428.57 * 0.8, 2);
  });

  it("não mexe no custo quando a nota não tem desconto", () => {
    const custo = custoComDescontoDaNf(
      1500,
      { compra_gc_id: "555", v_desc: 0, v_un_com: 1500, q_com: 1, valor_unitario_nf: 1500 },
      compra,
    );
    expect(custo).toBe(1500);
  });

  it("ignora desconto maior que o próprio item em vez de zerar o custo", () => {
    // Dado inconsistente. Zerar levaria o preço de venda a zero, que é pior
    // do que manter o custo bruto e aparecer caro.
    const custo = custoComDescontoDaNf(
      100,
      { compra_gc_id: "555", v_desc: 150, v_un_com: 100, q_com: 1 },
      compra,
    );
    expect(custo).toBe(100);
  });

  it("sobrevive a nota ausente, compra ausente e custo zero", () => {
    expect(custoComDescontoDaNf(500, null, compra)).toBe(500);
    expect(custoComDescontoDaNf(500, { v_desc: 100, v_un_com: 500, q_com: 1 }, null)).toBe(500);
    expect(custoComDescontoDaNf(0, null, null)).toBe(0);
  });

  it("fatorDescontoNf devolve a fração que sobra", () => {
    expect(
      fatorDescontoNf({ compra_gc_id: "555", v_desc: 10530, v_un_com: 27000, q_com: 1 }, compra),
    ).toBeCloseTo(0.61, 4);
    expect(fatorDescontoNf(null, compra)).toBe(1);
  });
});
