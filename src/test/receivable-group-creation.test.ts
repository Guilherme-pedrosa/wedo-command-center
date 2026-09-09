import { beforeEach, describe, expect, it, vi } from "vitest";
const { updateGC, rpc, sequence } = vi.hoisted(() => ({ updateGC: vi.fn(), rpc: vi.fn(), sequence: [] as string[] }));
vi.mock("@/api/financeiro", () => ({ atualizarRecebimentoGC: updateGC }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));
import { createVerifiedReceivableGroup } from "../api/receivable-group";

const input = () => ({ id: "request-1", name: "PRIMA FOODS ARAGUARI", dueDate: "2026-09-23", receipts: [{
  id: "ef6923b7-435b-4d9e-b313-34146c03dc8a", gc_id: "545977049", valor: 13771.45,
  cliente_gc_id: "40298490", nome_cliente: "PRIMA FOODS ARAGUARI", grupo_id: null, liquidado: false,
}] });
beforeEach(() => {
  vi.clearAllMocks(); sequence.length = 0;
  updateGC.mockImplementation(async () => { sequence.push("GC confirmado"); });
  rpc.mockImplementation(async (_name, args) => {
    if (args.p_check_only) return { data: null, error: null };
    sequence.push("grupo persistido"); return { data: { id: "request-1" }, error: null };
  });
});
describe("grupo exige confirmação externa e gravação atômica", () => {
  it("confirma o GC antes de anexar o título e conserva o cliente", async () => {
    const result = await createVerifiedReceivableGroup(input());
    expect(sequence).toEqual(["GC confirmado", "grupo persistido"]);
    expect(result.total).toBe(13771.45); expect(result.client).toBe("40298490");
    expect(rpc).toHaveBeenCalledWith("fin_create_receivable_group", expect.objectContaining({
      p_id: "request-1", p_data_vencimento: "2026-09-23", p_expected_values: { "ef6923b7-435b-4d9e-b313-34146c03dc8a": 13771.45 },
    }));
  });
  it("o caso parcial 5271,04 de 13771,45 não cria grupo nem passivo local antes da negociação", async () => {
    const request = input(); Object.assign(request.receipts[0], { selectedValue: 5271.04 });
    await expect(createVerifiedReceivableGroup(request)).rejects.toThrow(/dividir/);
    expect(updateGC).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
  it("valida todos os títulos antes de alterar o primeiro", async () => {
    const request = input(); request.receipts.push({ ...request.receipts[0], id: "another", cliente_gc_id: "outro" });
    await expect(createVerifiedReceivableGroup(request)).rejects.toThrow(/cliente/);
    expect(updateGC).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
  it("erro no GC impede criação local e continua visível", async () => {
    updateGC.mockRejectedValue(new Error("GC não confirmou vencimento"));
    await expect(createVerifiedReceivableGroup(input())).rejects.toThrow(/não confirmou/);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1].p_check_only).toBe(true);
  });
  it("erro no banco não se transforma em sucesso", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "título já agrupado" } });
    await expect(createVerifiedReceivableGroup(input())).rejects.toThrow("título já agrupado");
    expect(updateGC).not.toHaveBeenCalled();
  });
  it("retoma a confirmação perdida sem repetir o PUT de um grupo já salvo", async () => {
    rpc.mockResolvedValue({ data: { id: "request-1", reused: true }, error: null });
    expect((await createVerifiedReceivableGroup(input())).reused).toBe(true);
    expect(updateGC).not.toHaveBeenCalled();
  });
});
