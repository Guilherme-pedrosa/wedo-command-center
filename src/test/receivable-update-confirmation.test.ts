import { beforeEach, describe, expect, it, vi } from "vitest";
const { callGC } = vi.hoisted(() => ({ callGC: vi.fn() }));
vi.mock("@/lib/gc-client", () => ({ callGC }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
import { atualizarRecebimentoGC } from "../api/financeiro";

const receipt = () => ({ id: "545977049", codigo: "36392", valor: "13771.45", valor_total: "13771.45",
  cliente_id: "40298490", liquidado: "0", descricao: "NF3286 Passivo OS 9099", data_vencimento: "2026-09-23",
  data_competencia: "2026-03-31", plano_contas_id: "1", forma_pagamento_id: "2", conta_bancaria_id: "3",
  desconto: "0.00", juros: "0.00", taxa_banco: "0.00" });
const response = (raw: unknown) => ({ status: 200, data: { code: 200, data: raw }, duration_ms: 1 });
beforeEach(() => vi.clearAllMocks());

describe("atualização de recebimento confirmada pelo próprio GC", () => {
  it("preserva o valor atual e exige GET depois do PUT, mesmo com cache divergente", async () => {
    let raw = receipt();
    callGC.mockImplementation(async ({ method, payload }) => {
      if (method === "PUT") raw = { ...raw, ...payload };
      return response(raw);
    });
    await atualizarRecebimentoGC(raw.id, { valor: "5271.04", data_vencimento: "2026-11-02" }, { data_vencimento: "2026-10-23" });
    expect(raw.valor).toBe("13771.45"); expect(raw.data_vencimento).toBe("2026-10-23");
    expect(callGC.mock.calls.map(([request]) => request.method || "GET")).toEqual(["GET", "PUT", "GET"]);
    expect(callGC.mock.calls[1][0].payload).toMatchObject({ desconto: "0.00", juros: "0.00", taxa_banco: "0.00" });
  });
  it("não anuncia sucesso se HTTP 200 deixou o vencimento antigo", async () => {
    callGC.mockResolvedValue(response(receipt()));
    await expect(atualizarRecebimentoGC("545977049", {}, { data_vencimento: "2026-10-23" })).rejects.toThrow(/não confirmou/);
  });
  it.each([
    { valor: "13700.00" }, { cliente_id: "outro" }, { liquidado: "1" },
  ])("recusa seleção desatualizada antes do PUT: %j", async patch => {
    callGC.mockResolvedValue(response({ ...receipt(), ...patch }));
    await expect(atualizarRecebimentoGC("545977049", {}, { data_vencimento: "2026-10-23" },
      { expectedValue: 13771.45, expectedClientId: "40298490" })).rejects.toThrow();
    expect(callGC).toHaveBeenCalledTimes(1);
  });
  it("recusa uma falha embutida do GC sem continuar a gravação", async () => {
    callGC.mockResolvedValue({ status: 200, data: { code: 400, message: "recusado" } });
    await expect(atualizarRecebimentoGC("545977049", {}, { data_vencimento: "2026-10-23" })).rejects.toThrow("recusado");
    expect(callGC).toHaveBeenCalledTimes(1);
  });
});
