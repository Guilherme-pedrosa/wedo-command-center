import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { financialActor, financialErrorStatus } from "../../supabase/functions/_shared/financial-auth";

async function requestLegacyTag(authorization: string | null, role = "gerente_financeiro") {
  const source = fs.readFileSync("supabase/functions/tag-passivos/index.ts", "utf8").replace(/^import .*;\r?\n/gm, "");
  let handler: (r: Request) => Promise<Response>;
  const network = vi.fn(() => { throw new Error("Rede proibida no teste"); });
  const admin = {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "test-user" } }, error: null })) },
    from: () => {
      const query: any = { select: () => query, eq: () => query, in: () => query, then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: role === "reader" ? [] : [{ role }], error: null }).then(resolve) };
      return query;
    },
  };
  vm.runInNewContext(stripTypeScriptTypes(source), {
    serve: (h: typeof handler) => { handler = h; }, createClient: () => admin,
    financialActor, financialErrorStatus, Request, Response, fetch: network,
    Deno: { env: { get: (name: string) => name === "SUPABASE_URL" ? "https://mock.invalid" : "mock-service-key" } },
  });
  const response = await handler!(new Request("https://mock.invalid/tag-passivos", { method: "POST", headers: authorization ? { authorization } : {}, body: JSON.stringify({ cliente_gc_id: "123", os_codigos: ["9000"] }) }));
  expect(network).not.toHaveBeenCalled();
  return { response, body: await response.json() };
}

describe("endpoint legado de alteração de passivos", () => {
  it("exige autenticação", async () => { expect((await requestLegacyTag(null)).response.status).toBe(401); });
  it("exige perfil financeiro", async () => { expect((await requestLegacyTag("Bearer mock-user", "reader")).response.status).toBe(403); });
  it("recusa alteração legada mesmo para usuário financeiro, sem chamar GC", async () => {
    const { response, body } = await requestLegacyTag("Bearer mock-user");
    expect(response.status).toBe(409); expect(body.code).toBe("LEGACY_TAGGING_DISABLED"); expect(body.success).toBe(false);
  });
});
