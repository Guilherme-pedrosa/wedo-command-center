import { describe, expect, it } from "vitest";
import { normalizeOrigemFiscal, origemNfParaCadastroGc } from "@/lib/origemFiscal";

describe("origem fiscal da mercadoria", () => {
  it("normaliza os códigos aceitos pelo cadastro fiscal", () => {
    expect(normalizeOrigemFiscal("2 - Estrangeira")).toBe("2");
    expect(normalizeOrigemFiscal(0)).toBe("0");
    expect(normalizeOrigemFiscal(null)).toBe("");
    expect(normalizeOrigemFiscal("10")).toBe("");
  });

  it("converte importação direta do fornecedor em aquisição no mercado interno pela WeDo", () => {
    expect(origemNfParaCadastroGc("1")).toBe("2");
    expect(origemNfParaCadastroGc("6")).toBe("7");
  });

  it("preserva as demais origens informadas na NF", () => {
    for (const origem of ["0", "2", "3", "4", "5", "7", "8"]) {
      expect(origemNfParaCadastroGc(origem)).toBe(origem);
    }
  });
});
