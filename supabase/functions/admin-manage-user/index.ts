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
    const { action, user_id, nome, gc_codigo, auvo_codigo, role, password } = await req.json();

    if (action === "update") {
      if (!user_id) throw new Error("user_id obrigatório");

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

      // Update role if provided
      if (role) {
        await adminClient.from("user_roles").delete().eq("user_id", user_id);
        await adminClient.from("user_roles").insert({ user_id, role });
      }

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "delete") {
      if (!user_id) throw new Error("user_id obrigatório");
      if (user_id === callerId) throw new Error("Você não pode deletar sua própria conta.");

      const { error } = await adminClient.auth.admin.deleteUser(user_id);
      if (error) throw new Error(error.message);

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
