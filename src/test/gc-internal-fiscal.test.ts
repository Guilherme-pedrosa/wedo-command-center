import { describe, expect, it } from "vitest";
import {
  internalProductTax,
  isFiscalOnlyProductPayload,
  mergeGcInternalFiscal,
  prepareGcInternalProductForSave,
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

  it("separa correção fiscal pura de escritas públicas de preço e custo", () => {
    expect(isFiscalOnlyProductPayload({ ncm: "39201099", origem: "2" })).toBe(true);
    expect(isFiscalOnlyProductPayload({ origem: "0" })).toBe(true);
    expect(isFiscalOnlyProductPayload({ ncm: "39201099" })).toBe(false);
    expect(isFiscalOnlyProductPayload({ ncm: "39201099", origem: "2", valor_custo: "10" })).toBe(false);
    expect(isFiscalOnlyProductPayload({ origem: "rateio_frete_embutido" })).toBe(false);
  });

  it("reproduz os campos derivados que a tela oficial envia no POST", () => {
    const result = prepareGcInternalProductForSave({
      Produto: { valor_custo: "100", quantidade_saida: "2", possui_composicao: "0" },
      TiposValoresProduto: [{
        id: "10",
        lucro: "20",
        ProdutosTiposValoresProduto: { valor_venda: "60.00" },
      }],
      Fornecedor: [{ id: "30" }],
      Loja: [{ id: "40" }],
      ProdutosTributacao: { NCM: "39201099", ICMS_orig: "2" },
    }, () => 0.123);

    expect(result).toEqual({
      ok: true,
      payload: expect.objectContaining({
        ProdutosTiposValoresProduto: {
          "10": {
            valor_venda: "60.00",
            lucro_sugerido: "20",
            valor_venda_sugerido: "60.00",
          },
        },
        ProdutosComposicao: [],
        ProdutosFornecedor: [{ fornecedor_id: "30", chave: 0.123 }],
        ProdutosLoja: [{ id: "40" }],
        lotesPorLoja: null,
      }),
    });
  });

  it("aborta antes do POST quando o GET não permite preservar o cadastro", () => {
    expect(prepareGcInternalProductForSave({
      Produto: { possui_composicao: "1" },
      TiposValoresProduto: [],
      Fornecedor: [],
      Loja: [],
    })).toMatchObject({ ok: false });

    expect(prepareGcInternalProductForSave({
      Produto: { possui_composicao: true },
      TiposValoresProduto: [],
      Fornecedor: [],
      Loja: [],
    })).toMatchObject({ ok: false });
  });
});
