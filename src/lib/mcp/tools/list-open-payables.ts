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
  name: "list_open_payables",
  title: "Listar pagamentos em aberto",
  description:
    "Lista contas a pagar em aberto (não liquidadas), opcionalmente filtrando por fornecedor ou período de vencimento.",
  inputSchema: {
    fornecedor: z.string().optional().describe("Filtro parcial pelo nome do fornecedor."),
    vencimento_ate: z
      .string()
      .optional()
      .describe("Data de vencimento máxima (YYYY-MM-DD)."),
    limit: z.number().int().min(1).max(200).default(50),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ fornecedor, vencimento_ate, limit }, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Não autenticado" }], isError: true };
    let q = client(ctx)
      .from("fin_pagamentos")
      .select(
        "id, gc_codigo, descricao, nome_fornecedor, valor, data_vencimento, data_emissao, status, os_codigo, nf_numero",
      )
      .eq("liquidado", false)
      .neq("status", "cancelado")
      .order("data_vencimento", { ascending: true })
      .limit(limit);
    if (fornecedor) q = q.ilike("nome_fornecedor", `%${fornecedor}%`);
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
