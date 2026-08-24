import { describe, expect, it } from "vitest";
import {
  normalizeOrigemFiscal,
  origemNfParaCadastroGc,
  origemRegistradaNoArgus,
  ORIGENS_FISCAIS_GC,
  resolverOrigemFiscal,
} from "@/lib/origemFiscal";

describe("origem fiscal da mercadoria", () => {
  it("normaliza os códigos aceitos pelo cadastro fiscal", () => {
    expect(normalizeOrigemFiscal("2 - Estrangeira")).toBe("2");
    expect(normalizeOrigemFiscal(0)).toBe("0");
    expect(normalizeOrigemFiscal(null)).toBe("");
    expect(normalizeOrigemFiscal("10")).toBe("");
  });

  it("preserva exatamente todos os códigos informados na NF", () => {
    for (const origem of ["0", "1", "2", "3", "4", "5", "6", "7", "8"]) {
      expect(origemNfParaCadastroGc(origem)).toBe(origem);
    }
  });

  it("usa exatamente a numeração e os significados exibidos pelo GC", () => {
    expect(ORIGENS_FISCAIS_GC).toEqual([
      { codigo: "0", descricao: "Nacional, exceto as indicadas nos códigos de 3 a 5" },
      { codigo: "1", descricao: "Estrangeira - Importação direta, exceto a indicada no código 6" },
      { codigo: "2", descricao: "Estrangeira - Adquirida no mercado interno, exceto a indicada no código 7" },
      { codigo: "3", descricao: "Nacional, mercadoria ou bem com Conteúdo de Importação superior a 40%" },
      { codigo: "4", descricao: "Nacional, produção em conformidade com processos básicos que tratam as legislações dos Ajustes" },
      { codigo: "5", descricao: "Nacional, mercadoria ou bem com Conteúdo de Importação inferior ou igual a 40%" },
      { codigo: "6", descricao: "Estrangeira - Importação direta, sem similar nacional, constante em lista da CAMEX" },
      { codigo: "7", descricao: "Estrangeira - Adquirida mercado interno, sem similar nacional, constante em lista da CAMEX" },
      { codigo: "8", descricao: "Nacional, mercadoria ou bem com Conteúdo de Importação superior a 70%" },
    ]);
  });

  it("preserva uma correção do Argus sem esconder divergência da NF", () => {
    expect(origemRegistradaNoArgus("3", "2")).toBe("3");
    expect(origemRegistradaNoArgus("", "3")).toBe("3");
    expect(origemRegistradaNoArgus("0", "3")).toBe("0");
  });

  it("resolve origem manual antes da NF e mantém divergência legada visível", () => {
    expect(resolverOrigemFiscal({ manual: "3", nf: "2", legado: "1" })).toEqual({
      origemEfetiva: "3",
      divergenciaManual: true,
      divergenciaLegada: false,
    });
    expect(resolverOrigemFiscal({ manual: "", nf: "2", legado: "3" })).toEqual({
      origemEfetiva: "2",
      divergenciaManual: false,
      divergenciaLegada: true,
    });
    expect(resolverOrigemFiscal({ manual: "", nf: "", legado: "3" })).toEqual({
      origemEfetiva: "3",
      divergenciaManual: false,
      divergenciaLegada: false,
    });
  });
});
