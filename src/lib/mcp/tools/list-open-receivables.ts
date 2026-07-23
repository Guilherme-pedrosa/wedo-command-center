import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function client(ctx: ToolContext) {
  return createClient(
    process.env.SUPABASE_URL!,
    (process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY)!,
    {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

export default defineTool({
  name: "list_open_receivables",
  title: "Listar recebimentos em aberto",
  description:
    "Lista recebimentos financeiros em aberto (não liquidados), opcionalmente filtrando por cliente ou período de vencimento.",
  inputSchema: {
    cliente: z.string().optional().describe("Filtro parcial pelo nome do cliente."),
    vencimento_ate: z
      .string()
      .optional()
      .describe("Data de vencimento máxima (YYYY-MM-DD)."),
    limit: z.number().int().min(1).max(200).default(50),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ cliente, vencimento_ate, limit }, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Não autenticado" }], isError: true };
    let q = client(ctx)
      .from("fin_recebimentos")
      .select(
        "id, gc_codigo, descricao, nome_cliente, valor, data_vencimento, data_emissao, status, os_codigo, nf_numero",
      )
      .eq("liquidado", false)
      .neq("status", "cancelado")
      .order("data_vencimento", { ascending: true })
      .limit(limit);
    if (cliente) q = q.ilike("nome_cliente", `%${cliente}%`);
    if (vencimento_ate) q = q.lte("data_vencimento", vencimento_ate);
    const { data, error } = await q;
    if (error)
      return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: { rows: data ?? [], count: data?.length ?? 0 },
    };
  },
});
