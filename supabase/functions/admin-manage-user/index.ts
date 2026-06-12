import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

async function verifyAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new Error("Não autorizado");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: caller } } = await callerClient.auth.getUser();
  if (!caller) throw new Error("Não autorizado");

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { data: roleData } = await adminClient
    .from("user_roles")
    .select("role")
    .eq("user_id", caller.id)
    .eq("role", "admin")
    .maybeSingle();

  if (!roleData) throw new Error("Acesso negado. Apenas admins.");

  return { adminClient, callerId: caller.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { adminClient, callerId } = await verifyAdmin(req);
    const { data: callerProfile } = await adminClient.from("profiles").select("email").eq("id", callerId).maybeSingle();
    const callerEmail = callerProfile?.email ?? null;

    const { action, user_id, nome, gc_codigo, auvo_codigo, role, roles, password } = await req.json();

    if (action === "update") {
      if (!user_id) throw new Error("user_id obrigatório");

      // Snapshot ANTES
      const { data: beforeProfile } = await adminClient.from("profiles").select("*").eq("id", user_id).maybeSingle();
      const { data: beforeRoles } = await adminClient.from("user_roles").select("role").eq("user_id", user_id);
      const beforeSnapshot = { ...(beforeProfile ?? {}), roles: (beforeRoles ?? []).map((r: any) => r.role) };

      // Update profile
      const updates: Record<string, any> = {};
      if (nome !== undefined) updates.nome = nome;
      if (gc_codigo !== undefined) updates.gc_codigo = gc_codigo;
      if (auvo_codigo !== undefined) updates.auvo_codigo = auvo_codigo;
      
      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date().toISOString();
        await adminClient.from("profiles").update(updates).eq("id", user_id);
      }

      // Update password if provided
      if (password) {
        const { error } = await adminClient.auth.admin.updateUserById(user_id, { password });
        if (error) throw new Error(error.message);
      }

      // Update roles if provided (accepts roles[] or legacy role)
      const VALID_ROLES = ["admin", "user", "ceo", "gerente_comercial", "gerente_financeiro", "vendedor"];
      let newRoles: string[] | null = null;
      if (Array.isArray(roles)) {
        newRoles = Array.from(new Set(roles.filter((r: string) => VALID_ROLES.includes(r))));
      } else if (role) {
        newRoles = [role].filter((r: string) => VALID_ROLES.includes(r));
      }
      if (newRoles !== null) {
        if (newRoles.length === 0) newRoles = ["user"];
        await adminClient.from("user_roles").delete().eq("user_id", user_id);
        await adminClient.from("user_roles").insert(
          newRoles.map((r) => ({ user_id, role: r }))
        );
      }

      // Snapshot DEPOIS
      const { data: afterProfile } = await adminClient.from("profiles").select("*").eq("id", user_id).maybeSingle();
      const { data: afterRoles } = await adminClient.from("user_roles").select("role").eq("user_id", user_id);
      const afterSnapshot = {
        ...(afterProfile ?? {}),
        roles: (afterRoles ?? []).map((r: any) => r.role),
        password_changed: !!password,
      };

      await adminClient.from("audit_trail").insert({
        user_id: callerId,
        user_email: callerEmail,
        action_type: "auth",
        action: "user_updated",
        table_name: "auth.users",
        record_id: user_id,
        before_data: beforeSnapshot,
        after_data: afterSnapshot,
        context: { source: "edge:admin-manage-user", password_reset: !!password },
        severity: password ? "warning" : "info",
      });

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "delete") {
      if (!user_id) throw new Error("user_id obrigatório");
      if (user_id === callerId) throw new Error("Você não pode deletar sua própria conta.");

      // Snapshot completo ANTES da exclusão (preserva rastreabilidade)
      const { data: profSnapshot } = await adminClient.from("profiles").select("*").eq("id", user_id).maybeSingle();
      const { data: rolesSnapshot } = await adminClient.from("user_roles").select("role").eq("user_id", user_id);
      const beforeSnapshot = {
        ...(profSnapshot ?? {}),
        roles: (rolesSnapshot ?? []).map((r: any) => r.role),
      };

      const { error } = await adminClient.auth.admin.deleteUser(user_id);
      if (error) throw new Error(error.message);

      await adminClient.from("audit_trail").insert({
        user_id: callerId,
        user_email: callerEmail,
        action_type: "auth",
        action: "user_deleted",
        table_name: "auth.users",
        record_id: user_id,
        before_data: beforeSnapshot,
        context: { source: "edge:admin-manage-user" },
        severity: "critical",
      });

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    throw new Error("Ação inválida. Use 'update' ou 'delete'.");
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
