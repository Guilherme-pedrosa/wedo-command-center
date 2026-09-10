import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), getUser: vi.fn(), readJob: vi.fn(), job: {} as any, clients: [] as any[],
  success: vi.fn(), error: vi.fn(), loading: vi.fn(() => "toast"), dismiss: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {
  auth: { getUser: mocks.getUser }, functions: { invoke: mocks.invoke },
  from: (table: string) => {
    const query: any = {
      select: () => query, eq: () => query, order: () => query, limit: () => query,
      maybeSingle: async () => table === "fin_negociacao_jobs" ? mocks.readJob() : ({ data: null, error: null }),
      then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return query;
  },
} }));
vi.mock("@/lib/gc-client", () => ({ callGC: vi.fn(async () => ({ status: 200, data: { data: [] } })) }));
vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { success: mocks.success, error: mocks.error, loading: mocks.loading, dismiss: mocks.dismiss }) }));
import NegociacaoOSPage from "@/pages/financeiro/NegociacaoOSPage";

const key = "wedo:negociacao:pending:user-1";
const pending = {
  idempotency_key: "1fc2e654-64a4-4d4a-b94d-074aa4d0641d",
  payload: { os_ids: ["os-1"], residual_ids: [], cliente_gc_id: "client-1", parcelas: 1, valor_negociado: 600, valores_parcelas: [600], mes_inicio: "2026-09", dia_vencimento: 30 },
  os_map: { "os-1": "9000" },
};
const mount = () => render(<MemoryRouter><NegociacaoOSPage /></MemoryRouter>);
const enqueueCalls = () => mocks.invoke.mock.calls.filter(([, options]) => options.body?.action === "enqueue");

describe("recuperação da negociação pela página real", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key), clear: () => storage.clear() });
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Rede proibida no teste"); }));
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    mocks.job = { status: "concluido", erro_count: 0, resultado: { success: true, integrity_verified: true, results: [], pendencias: [] } };
    mocks.readJob.mockImplementation(async () => ({ data: mocks.job, error: null }));
    mocks.clients = [];
    mocks.invoke.mockImplementation(async (_name, options) => options.body.action === "enqueue" ? { data: { success: true, job_id: "job-1", status: "pendente" }, error: null } : { data: { clients: mocks.clients }, error: null });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("envio pelo formulário mantém progresso no diálogo e após fechar, sem permitir outro envio", async () => {
    vi.useFakeTimers();
    mocks.clients = [{ cliente_id: "client-1", nome_cliente: "Cliente de teste", valor_total: 600, os_list: [
      { id: "os-1", codigo: "9000", descricao: "Serviço", valor_total: 600, data: "2026-09-10" },
    ] }];
    mocks.job = { status: "pendente", progresso: "Origens reservadas; aguardando execução" };
    await act(async () => { mount(); });
    await act(async () => { fireEvent.click(screen.getByText("Cliente de teste")); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Negociar", exact: true })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Executar Negociação" })); });
    expect(enqueueCalls()).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Origens reservadas; aguardando execução");
    expect(screen.queryByRole("button", { name: "Executar Negociação" })).not.toBeInTheDocument();
    expect(mocks.error).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Fechar acompanhamento" }));
    expect(screen.getByRole("status")).toHaveTextContent("Origens reservadas; aguardando execução");
    mocks.job = { status: "processando", progresso: "Conferindo títulos no GC" };
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("Conferindo títulos no GC");
    expect(enqueueCalls()).toHaveLength(1);
  });

  it("pedido aceito continua da fila até a conclusão, com progresso e sem novo envio", async () => {
    vi.useFakeTimers();
    mocks.job = { status: "pendente", progresso: "Origens reservadas; aguardando execução" };
    localStorage.setItem(key, JSON.stringify(pending));
    await act(async () => { mount(); });
    expect(enqueueCalls()).toHaveLength(1);
    expect(mocks.error).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Origens reservadas; aguardando execução");
    expect(JSON.parse(localStorage.getItem(key)!).job_id).toBe("job-1");

    mocks.job = { status: "processando", progresso: "Conferindo títulos no GC" };
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("Conferindo títulos no GC");
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();

    mocks.job = { status: "concluido", erro_count: 0, resultado: { success: true, integrity_verified: true, results: [], pendencias: [] } };
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(mocks.success).toHaveBeenCalledWith("Negociação concluída e composição conferida.");
    expect(enqueueCalls()).toHaveLength(1);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("uma consulta indisponível não encerra o acompanhamento nem reenvia a negociação", async () => {
    vi.useFakeTimers();
    mocks.job = { status: "processando", progresso: "Conferindo títulos no GC" };
    mocks.readJob.mockResolvedValueOnce({ data: null, error: { message: "Conexão interrompida" } });
    localStorage.setItem(key, JSON.stringify({ ...pending, job_id: "job-1" }));
    await act(async () => { mount(); });
    expect(mocks.error).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/consultar o andamento/);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("Conferindo títulos no GC");
    expect(enqueueCalls()).toHaveLength(0);
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  it("acompanha jobs longos e para as consultas ao sair da página, preservando a retomada", async () => {
    vi.useFakeTimers();
    mocks.job = { status: "processando", progresso: "Conferindo títulos no GC" };
    localStorage.setItem(key, JSON.stringify({ ...pending, job_id: "job-1" }));
    let view: ReturnType<typeof mount>;
    await act(async () => { view = mount(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(363000); });
    expect(mocks.readJob.mock.calls.length).toBeGreaterThan(120);
    expect(screen.getByRole("status")).toHaveTextContent("Conferindo títulos no GC");
    const calls = mocks.readJob.mock.calls.length;
    view!.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(mocks.readJob).toHaveBeenCalledTimes(calls);
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(enqueueCalls()).toHaveLength(0);
  });

  it("retoma um job conhecido após reload sem reenviar a operação", async () => {
    localStorage.setItem(key, JSON.stringify({ ...pending, job_id: "job-1" }));
    mount();
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Negociação concluída e composição conferida."));
    expect(enqueueCalls()).toHaveLength(0);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("resposta perdida preserva pedido e UUID, e reload repete exatamente a mesma chave", async () => {
    localStorage.setItem(key, JSON.stringify(pending));
    let enqueueAttempts = 0;
    mocks.invoke.mockImplementation(async (_name, options) => {
      if (options.body.action !== "enqueue") return { data: { clients: [] }, error: null };
      enqueueAttempts++;
      return enqueueAttempts === 1 ? { data: null, error: new Error("Timeout após envio") } : { data: { job_id: "job-1" }, error: null };
    });
    const first = mount();
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Timeout após envio"));
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(pending);
    first.unmount(); mount();
    await waitFor(() => expect(mocks.success).toHaveBeenCalled());
    expect(enqueueCalls()).toHaveLength(2);
    expect(enqueueCalls()[0][1].body).toEqual(enqueueCalls()[1][1].body);
    expect(enqueueCalls()[1][1].body.idempotency_key).toBe(pending.idempotency_key);
  });

  it.each(["concluido", "pendente_conferencia"])("não anuncia sucesso nem descarta %s sem integridade confirmada", async status => {
    mocks.job = { status, erro_count: 0, resultado: { success: true, results: [] } };
    localStorage.setItem(key, JSON.stringify({ ...pending, job_id: "job-1" }));
    mount();
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.success).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  it("libera edição do pedido somente após recusa explícita anterior à execução", async () => {
    localStorage.setItem(key, JSON.stringify(pending));
    const rejected = Object.assign(new Error("Pedido inválido"), { context: Response.json({ success: false, pending_reconciliation: false, error: "Pedido inválido" }, { status: 409 }) });
    mocks.invoke.mockImplementation(async (_name, options) => options.body.action === "enqueue" ? { data: null, error: rejected } : { data: { clients: [] }, error: null });
    mount();
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Pedido inválido"));
    expect(localStorage.getItem(key)).toBeNull();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("não retoma um pedido salvo por outro usuário", async () => {
    localStorage.setItem("wedo:negociacao:pending:another-user", JSON.stringify(pending));
    mount();
    await waitFor(() => expect(mocks.getUser).toHaveBeenCalled());
    expect(enqueueCalls()).toHaveLength(0);
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("retomar conferência usa o mesmo job com action resume, sem reenfileirar", async () => {
    mocks.job = { status: "erro", erro_count: 1, erro_msg: "Conferência necessária", resultado: { success: false } };
    localStorage.setItem(key, JSON.stringify({ ...pending, job_id: "job-1" }));
    mocks.invoke.mockImplementation(async (_name, options) => {
      if (options.body.action === "resume") {
        mocks.job = { status: "concluido", erro_count: 0, resultado: { success: true, integrity_verified: true, pendencias: [], results: [] } };
        return { data: { job_id: "job-1" }, error: null };
      }
      return { data: { clients: [] }, error: null };
    });
    mount();
    const button = await screen.findByRole("button", { name: "Retomar conferência" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(mocks.success).toHaveBeenCalled());
    expect(mocks.invoke.mock.calls.filter(([, options]) => options.body?.action === "resume")[0][1].body).toEqual({ action: "resume", job_id: "job-1" });
    expect(enqueueCalls()).toHaveLength(0);
  });
});
