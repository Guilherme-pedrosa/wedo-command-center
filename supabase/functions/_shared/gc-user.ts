// Proteção global: toda chamada ao GestãoClick usa exclusivamente o usuário técnico da API.
import { installGcUsuarioId as installGcUsuarioIdCore } from "./gc-user-core.ts";
import { GC_API_USER_ID } from "./gc-user-id.ts";
export { GC_API_USER_ID } from "./gc-user-id.ts";

export function gcHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    ...(extra ?? {}),
    "access-token": Deno.env.get("GC_ACCESS_TOKEN") ?? "",
    "secret-access-token": Deno.env.get("GC_SECRET_TOKEN") ?? "",
    "Content-Type": "application/json",
    "usuario-id": GC_API_USER_ID,
  };
}

export function installGcUsuarioId() {
  installGcUsuarioIdCore(GC_API_USER_ID);
}
