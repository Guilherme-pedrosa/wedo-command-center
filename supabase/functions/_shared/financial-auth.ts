export async function financialActor(req: Request, admin: any, serviceKey: string): Promise<{ userId: string | null; internal: boolean }> {
  const authorization = req.headers.get("authorization") ?? "";
  if (serviceKey && authorization === `Bearer ${serviceKey}`) return { userId: null, internal: true };
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new Error("UNAUTHORIZED: autenticação obrigatória.");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) throw new Error("UNAUTHORIZED: sessão inválida.");
  const { data: roles, error: roleError } = await admin.from("user_roles").select("role").eq("user_id", data.user.id).in("role", ["admin", "ceo", "gerente_financeiro"]);
  if (roleError || !roles?.length) throw new Error("FORBIDDEN: perfil sem permissão financeira.");
  return { userId: data.user.id, internal: false };
}

export function financialErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("UNAUTHORIZED:") ? 401 : message.startsWith("FORBIDDEN:") ? 403 : 409;
}
