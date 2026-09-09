import assert from "node:assert/strict";
import { test } from "node:test";
import { forceGcApiUserInRequest } from "../supabase/functions/_shared/gc-user-core.ts";

const API_USER = "1320473";
for (const identity of [undefined, null, "", "  ", "1023771"]) {
  test(`REST replaces absent/blank/personal identity: ${String(identity)}`, async () => {
    const query = identity === undefined ? "" : `?usuario_id=${encodeURIComponent(String(identity))}&usuario_id=1023771`;
    const payload = { usuario_id: identity, vendedor_id: "1023771", tecnico_id: "321", cliente_id: "77", produtos: [{ produto_id: "5", quantidade: "2.00" }] };
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const request = await forceGcApiUserInRequest(`https://api.gestaoclick.com/api/vendas/1${query}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }, API_USER);
      assert.deepEqual(new URL(request.url).searchParams.getAll("usuario_id"), [API_USER]);
      assert.deepEqual(await request.json(), { ...payload, usuario_id: API_USER });
    }
    for (const method of ["GET", "HEAD"]) {
      const request = await forceGcApiUserInRequest(`https://api.gestaoclick.com/api/clientes${query}`, { method }, API_USER);
      assert.equal(new URL(request.url).searchParams.get("usuario_id"), API_USER);
    }
  });
}

test("Request/init overrides cannot restore the personal identity", async () => {
  const input = new Request("https://api.gestaoclick.com/api/vendas?usuario_id=1023771", {
    method: "PUT",
    body: JSON.stringify({ usuario_id: "1023771", vendedor_id: "99" }),
  });
  const request = await forceGcApiUserInRequest(input, {
    body: JSON.stringify({ usuario_id: null, vendedor_id: "99" }),
  }, API_USER);
  assert.deepEqual(await request.json(), { usuario_id: API_USER, vendedor_id: "99" });
  assert.equal(new URL(request.url).searchParams.get("usuario_id"), API_USER);
});

test("legacy configured GC host receives the same protected identity", async () => {
  const request = await forceGcApiUserInRequest("https://gestaoclick.com/api/produtos/1", {
    method: "PUT", body: JSON.stringify({ usuario_id: "1023771", nome: "Produto" }),
  }, API_USER);
  assert.equal(new URL(request.url).searchParams.get("usuario_id"), API_USER);
  assert.deepEqual(await request.json(), { usuario_id: API_USER, nome: "Produto" });
});

