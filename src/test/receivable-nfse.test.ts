import { describe, expect, it } from "vitest";
import { buildReceivableNfsePayload, assertReceivableNfseConfirmed } from "../../supabase/functions/_shared/receivable-nfse";

const receipt = () => ({ id: "545977049", cliente_id: "40298490", valor: "13771.45", valor_total: "13771.45",
  data_vencimento: "2026-09-23", data_competencia: "2026-03-31", plano_contas_id: "1", forma_pagamento_id: "2", conta_bancaria_id: "3",
  liquidado: "0", desconto: "0.00", juros: "0.00", descricao: "Passivo OS 9099 (negociação 69)", atributos: [{ atributo: { id: "17", conteudo: "original" } }] });

describe("NFS-e não é quitação nem renegociação", () => {
  it.each(["0", "1"])("anota a nota preservando título aberto ou pago (%s)", liquidado => {
    const before = { ...receipt(), liquidado };
    const payload = buildReceivableNfsePayload(before, { nfse_numero: "3286" });
    expect(payload).toMatchObject({ valor: "13771.45", data_vencimento: "2026-09-23", desconto: "0.00", juros: "0.00" });
    expect(payload).not.toHaveProperty("liquidado");
    expect(payload.atributos).toEqual([{ atributo: { atributo_id: "17", conteudo: "original" } }, { atributo: { atributo_id: "8928", conteudo: "3286" } }]);
    expect(() => assertReceivableNfseConfirmed(before, { ...before, ...payload }, payload)).not.toThrow();
  });
  it.each(["valor", "data_vencimento", "liquidado", "desconto", "cliente_id"])("recusa %s enviado junto com a nota", field => {
    expect(() => buildReceivableNfsePayload(receipt(), { nfse_numero: "3286", [field]: "1" })).toThrow(/somente/);
  });
  it.each([{ valor: "5271.04" }, { desconto: "8500.41" }, { liquidado: "1" }, { data_vencimento: "2026-10-23" }, { atributos: [] }])("não aceita HTTP bem-sucedido com alteração ou nota ausente: %j", patch => {
    const before = receipt(); const payload = buildReceivableNfsePayload(before, { nfse_numero: "3286" });
    expect(() => assertReceivableNfseConfirmed(before, { ...before, ...payload, ...patch }, payload)).toThrow();
  });
  it("repetição não duplica a identificação da nota", () => {
    const before = receipt(); const payload = buildReceivableNfsePayload(before, { nfse_numero: "3286" });
    expect(buildReceivableNfsePayload({ ...before, ...payload }, { nfse_numero: "3286" })).toEqual(payload);
  });
});
