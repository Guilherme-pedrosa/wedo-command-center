import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  forceGcApiUserInBody,
  forceGcApiUserInHeaders,
  forceGcApiUserInRequest,
  forceGcApiUserInUrl,
  isGestaoClickApiUrl,
} from "../../supabase/functions/_shared/gc-user-core";

const REQUIRED_GC_USER_ID = "1320473";
const root = process.cwd();

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(absolute) : [absolute];
  });
}

describe("proteção global do usuário técnico da API GestãoClick", () => {
  it("reconhece exclusivamente o host oficial do GC", () => {
    expect(isGestaoClickApiUrl("https://api.gestaoclick.com/api/clientes")).toBe(true);
    expect(isGestaoClickApiUrl("https://api.gestaoclick.com.evil.test/api/clientes")).toBe(false);
    expect(isGestaoClickApiUrl("https://example.com/api.gestaoclick.com")).toBe(false);
  });

  it("sobrescreve usuario_id na URL, no cabeçalho e no corpo JSON", () => {
    const url = new URL(forceGcApiUserInUrl(
      "https://api.gestaoclick.com/api/clientes?usuario_id=999&pagina=2",
      REQUIRED_GC_USER_ID,
    ));
    expect(url.searchParams.get("usuario_id")).toBe(REQUIRED_GC_USER_ID);
    expect(url.searchParams.get("pagina")).toBe("2");

    const headers = forceGcApiUserInHeaders({ "usuario-id": "999", Accept: "application/json" }, REQUIRED_GC_USER_ID);
    expect(headers.get("usuario-id")).toBe(REQUIRED_GC_USER_ID);
    expect(headers.get("accept")).toBe("application/json");

    expect(JSON.parse(String(forceGcApiUserInBody(
      JSON.stringify({ usuario_id: "999", nome: "Cliente" }),
      REQUIRED_GC_USER_ID,
    )))).toEqual({ usuario_id: REQUIRED_GC_USER_ID, nome: "Cliente" });
  });

  it("protege uma Request completa sem perder método ou payload", async () => {
    const request = await forceGcApiUserInRequest(
      "https://api.gestaoclick.com/api/ordens_servicos/1?usuario_id=123",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", "usuario-id": "123" },
        body: JSON.stringify({ situacao_id: "7", usuario_id: "123" }),
      },
      REQUIRED_GC_USER_ID,
    );

    expect(request.method).toBe("PUT");
    expect(new URL(request.url).searchParams.get("usuario_id")).toBe(REQUIRED_GC_USER_ID);
    expect(request.headers.get("usuario-id")).toBe(REQUIRED_GC_USER_ID);
    expect(JSON.parse(await request.text())).toEqual({ situacao_id: "7", usuario_id: REQUIRED_GC_USER_ID });
  });
});

describe("auditoria estática dos consumidores do GestãoClick", () => {
  it("instala o guard em toda Edge Function que conhece credenciais ou host do GC", () => {
    const functionsDir = join(root, "supabase", "functions");
    const candidates = filesUnder(functionsDir)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.includes(`${join("supabase", "functions", "_shared")}`))
      .filter((file) => /api\.gestaoclick\.com|GC_ACCESS_TOKEN|GC_SECRET_(?:ACCESS_)?TOKEN|["']access-token["']/.test(readFileSync(file, "utf8")));

    const offenders = candidates
      .filter((file) => !/installGcUsuarioId\(/.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file));

    expect(offenders).toEqual([]);
  });

  it("mantém o guard no source do MCP, não só no bundle gerado", () => {
    const entry = readFileSync(join(root, "src", "lib", "mcp", "index.ts"), "utf8");
    const client = readFileSync(join(root, "src", "lib", "mcp", "shared", "gc-client.ts"), "utf8");
    expect(client).toContain("api.gestaoclick.com");
    expect(entry).toContain("installGcUsuarioId");
    expect(entry).toMatch(/installGcUsuarioId\(GC_API_USER_ID\)/);
  });

  it("faz o gc-proxy sobrescrever qualquer usuário recebido", () => {
    const source = readFileSync(join(root, "supabase", "functions", "gc-proxy", "index.ts"), "utf8");
    expect(source).toContain('url.searchParams.set("usuario_id", GC_API_USER_ID)');
    expect(source).toContain('"usuario-id": GC_API_USER_ID');
    expect(source).toContain("{ ...payload, usuario_id: GC_API_USER_ID }");
  });

  it("limita a TV a quinze minutos e usa cache com trava no backend", () => {
    const page = readFileSync(join(root, "src", "pages", "TvTecnicos.tsx"), "utf8");
    const edge = readFileSync(join(root, "supabase", "functions", "tv-tecnicos-premiacao", "index.ts"), "utf8");
    const migration = readFileSync(
      join(root, "supabase", "migrations", "20260812083000_tv_tecnicos_premiacao_cache.sql"),
      "utf8",
    );

    expect(page).toContain("const TV_PREMIACAO_REFRESH_MS = 15 * 60 * 1000");
    expect(page).toContain("refetchInterval: TV_PREMIACAO_REFRESH_MS");
    expect(page).toContain("refetchIntervalInBackground: false");
    expect(page).toContain("refetchOnWindowFocus: false");
    expect(page).toContain("refetchOnReconnect: false");
    expect(page).not.toMatch(/invalidateQueries\(\{ queryKey: \['os_index_tecnicos'/);
    expect(edge).toContain('"claim_tv_tecnicos_premiacao_cache"');
    expect(edge).toContain("stale_while_refreshing");
    expect(migration).toContain("FOR UPDATE");
  });
});
