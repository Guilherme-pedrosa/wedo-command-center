import { describe, expect, it } from "vitest";
import {
  internalProductTax,
  mergeGcInternalFiscal,
  unwrapGcInternalProduct,
} from "../../supabase/functions/_shared/gc-internal-fiscal";

describe("cadastro fiscal interno do GestãoClick", () => {
  it("lê o envelope real que usa a chave literal request.data", () => {
    const response = {
      status: "success",
      data: {
        "request.data": {
          Produto: { id: "92922264", codigo: "231016" },
          ProdutosTributacao: [{ NCM: "90251990", ICMS_orig: "" }],
        },
      },
    };

    const product = unwrapGcInternalProduct(response);

    expect(product).not.toBeNull();
    expect(internalProductTax(product)).toMatchObject({
      NCM: "90251990",
      ICMS_orig: "",
    });
  });

  it("repete a normalização da tela oficial e grava origem 2 como texto", () => {
    const product = {
      Produto: { id: "92922264" },
      ProdutosTributacao: [{ NCM: "90251990", ICMS_orig: "", ICMS_CST: "00" }],
    };

    const updated = mergeGcInternalFiscal(product, "90251990", "2");

    expect(Array.isArray(updated.ProdutosTributacao)).toBe(false);
    expect(internalProductTax(updated)).toEqual({
      NCM: "90251990",
      ICMS_orig: "2",
      ICMS_CST: "00",
    });
  });

  it("mantém compatibilidade com o envelope legado aninhado", () => {
    expect(unwrapGcInternalProduct({
      data: { request: { data: { ProdutosTributacao: { ICMS_orig: "0" } } } },
    })).toEqual({ ProdutosTributacao: { ICMS_orig: "0" } });
  });
});
