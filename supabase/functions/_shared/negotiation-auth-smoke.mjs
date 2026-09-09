// Read-only deployment smoke. Never invokes scanner, worker, settlement or execute actions.
// Usage: node .../negotiation-auth-smoke.mjs https://PROJECT.supabase.co
// Optional SUPABASE_PUBLIC_KEY enables anonymous REST/RLS verification; no key is printed.
import assert from "node:assert/strict";
const base = new URL(process.argv[2]);
assert.match(base.hostname, /^[a-z0-9-]+\.supabase\.co$/);
assert.equal(base.protocol, "https:");
const key = process.env.SUPABASE_PUBLIC_KEY;
const cases = [
  { name: "Negociação anônima", path: "/functions/v1/negotiate-os", method: "POST", body: { action: "list" }, headers: {} },
  { name: "Negociação com token inválido", path: "/functions/v1/negotiate-os", method: "POST", body: { action: "list" }, headers: { Authorization: "Bearer invalid-auth-smoke-token" } },
];
if (key) for (const table of ["fin_grupos_receber", "fin_grupo_receber_itens", "fin_residuos_negociacao", "fin_negociacao_jobs"]) cases.push({ name: `REST anônimo ${table}`, path: `/rest/v1/${table}?select=id&limit=0`, method: "GET", headers: { apikey: key } });
let failed = 0;
for (const name of ["negotiate-os", "negotiate-os-worker", "scan-passivos", "gc-proxy", "argus-baixa-confirmada", "tag-passivos", "sync-all"]) {
  const result = await fetch(new URL(`/functions/v1/${name}`, base), { method: "OPTIONS", headers: key ? { apikey: key } : {} });
  await result.arrayBuffer();
  const protocol = result.headers.get("X-Wedo-Negotiation-Protocol");
  const deployed = result.ok && protocol === "20260909-v2";
  console.log(JSON.stringify({ check: `Protocolo ${name}`, status: result.status, protocol, deployed }));
  if (!deployed) failed++;
}
for (const check of cases) {
  const result = await fetch(new URL(check.path, base), { method: check.method, headers: { "Content-Type": "application/json", ...(key ? { apikey: key } : {}), ...check.headers }, ...(check.body ? { body: JSON.stringify(check.body) } : {}) });
  const data = await result.json().catch(() => ({}));
  const blocked = [401, 403].includes(result.status);
  // Only rejected-request metadata is printed, never financial rows.
  console.log(JSON.stringify({ check: check.name, status: result.status, blocked, ...(blocked ? { error: String(data.error ?? data.message ?? "").slice(0, 160) } : {}) }));
  if (!blocked) failed++;
}
if (!key) console.log("REST/RLS não consultado: SUPABASE_PUBLIC_KEY não configurada.");
if (failed) process.exitCode = 1;
