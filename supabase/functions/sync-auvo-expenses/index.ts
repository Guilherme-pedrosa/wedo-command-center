import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AUVO_BASE = "https://api.auvo.com.br/v2";
const TYPE_IDS = [48782, 48784, 49032, 48783, 48799, 50758];

async function auvoLogin(apiKey: string, apiToken: string): Promise<string> {
  const res = await fetch(`${AUVO_BASE}/login/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, apiToken }),
  });
  if (!res.ok) throw new Error(`Auvo login failed: ${res.status}`);
  const json = await res.json();
  const token = json?.result?.accessToken ?? json?.result?.token ?? json?.token;
  if (!token) throw new Error("Auvo login: accessToken not found");
  return token;
}

async function fetchExpensesByType(
  token: string,
  typeId: number,
  startDate: string,
  endDate: string
): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const filter = JSON.stringify({ startDate, endDate, type: typeId });
    const url = `${AUVO_BASE}/expenses/?paramFilter=${encodeURIComponent(filter)}&page=${page}&pageSize=${pageSize}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error(`Auvo expenses error typeId=${typeId} page=${page}: ${res.status}`);
      break;
    }
    const json = await res.json();
    const results = json?.result?.entityList ?? json?.result?.entities ?? [];
    if (!Array.isArray(results) || results.length === 0) break;
    all.push(...results);
    if (results.length < pageSize) break;
    page++;
  }
  return all;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("AUVO_API_KEY");
    const apiToken = Deno.env.get("AUVO_USER_TOKEN");
    if (!apiKey || !apiToken) {
      return new Response(
        JSON.stringify({ error: "AUVO_API_KEY and AUVO_USER_TOKEN secrets are required" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json().catch(() => ({}));
    const now = new Date();
    const mes = body.mes || now.getMonth() + 1;
    const ano = body.ano || now.getFullYear();
    const mesStr = String(mes).padStart(2, "0");
    const lastDay = new Date(ano, mes, 0).getDate();
    const startDate = `${ano}-${mesStr}-01`;
    const endDate = `${ano}-${mesStr}-${lastDay}`;

    // Login
    const token = await auvoLogin(apiKey, apiToken);

    // Supabase client
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    let totalSynced = 0;
    const byType: Record<string, { count: number; total: number }> = {};

    for (const typeId of TYPE_IDS) {
      const expenses = await fetchExpensesByType(token, typeId, startDate, endDate);
      let typeTotal = 0;

      if (expenses.length > 0) {
        const rows = expenses.map((e: any) => ({
          auvo_id: e.id,
          type_id: typeId,
          type_name: e.expenseTypeName || e.typeName || null,
          user_to_id: e.userToID || e.userToId || null,
          user_to_name: e.userToName || null,
          expense_date: e.date?.split("T")[0] || startDate,
          amount: parseFloat(e.value || e.amount || "0"),
          description: e.description || null,
          attachment_url: e.attachmentUrl || e.receiptUrl || null,
          synced_at: new Date().toISOString(),
        }));

        typeTotal = rows.reduce((s: number, r: any) => s + (r.amount || 0), 0);

        // Upsert in batches of 50
        for (let i = 0; i < rows.length; i += 50) {
          const batch = rows.slice(i, i + 50);
          const { error } = await supabase
            .from("auvo_expenses_sync")
            .upsert(batch, { onConflict: "auvo_id" });
          if (error) console.error(`Upsert error typeId=${typeId}:`, error.message);
        }

        totalSynced += expenses.length;
      }

      byType[String(typeId)] = { count: expenses.length, total: typeTotal };
    }

    return new Response(
      JSON.stringify({ synced: totalSynced, by_type: byType, period: { mes, ano } }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
