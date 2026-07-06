import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function client(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "finance_summary",
  title: "Resumo financeiro",
  description:
    "Retorna totais em aberto de recebimentos e pagamentos e o saldo previsto (a receber - a pagar).",
  inputSchema: {
    vencimento_ate: z
      .string()
      .optional()
      .describe("Considera apenas itens com data de vencimento até esta data (YYYY-MM-DD)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ vencimento_ate }, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Não autenticado" }], isError: true };
    const sb = client(ctx);
    const sumTable = async (table: "fin_recebimentos" | "fin_pagamentos") => {
      let q = sb
        .from(table)
        .select("valor")
        .eq("liquidado", false)
        .neq("status", "cancelado");
      if (vencimento_ate) q = q.lte("data_vencimento", vencimento_ate);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []).reduce((s, r: any) => s + Number(r.valor ?? 0), 0);
    };
    try {
      const [aReceber, aPagar] = await Promise.all([
        sumTable("fin_recebimentos"),
        sumTable("fin_pagamentos"),
      ]);
      const saldo = aReceber - aPagar;
      const structured = { a_receber: aReceber, a_pagar: aPagar, saldo_previsto: saldo };
      return {
        content: [{ type: "text", text: JSON.stringify(structured) }],
        structuredContent: structured,
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
  },
});
