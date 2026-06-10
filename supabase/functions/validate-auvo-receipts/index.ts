// Valida comprovantes Auvo via IA multimodal (Gemini): extrai valor + estabelecimento
// e compara com tipo/valor cadastrado. Marca status: ok | valor_divergente |
// tipo_divergente | ilegivel | sem_anexo | erro.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TOLERANCE_PCT = 0.02; // 2%
const TOLERANCE_ABS = 0.5;  // R$ 0,50
const DATE_TOLERANCE_DAYS = 3;

interface ExpenseRow {
  id: string;
  type_name: string | null;
  amount: number | null;
  description: string | null;
  attachment_url: string | null;
  expense_date: string | null;
}

interface IAResult {
  status: "ok" | "valor_divergente" | "tipo_divergente" | "data_divergente" | "ilegivel" | "sem_anexo" | "erro";
  notes: string;
  extracted_value: number | null;
  extracted_merchant: string | null;
  extracted_category: string | null;
  extracted_date: string | null;
}

async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return null;
    let ct = (res.headers.get("content-type") || "").toLowerCase();
    // S3 e outros CDNs frequentemente devolvem application/octet-stream ou binary/octet-stream.
    // Inferir o mime pela extensão do URL nesse caso.
    if (!ct.startsWith("image/")) {
      const lower = url.toLowerCase().split("?")[0];
      if (lower.endsWith(".png")) ct = "image/png";
      else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) ct = "image/jpeg";
      else if (lower.endsWith(".webp")) ct = "image/webp";
      else if (lower.endsWith(".gif")) ct = "image/gif";
      else if (lower.endsWith(".heic")) ct = "image/heic";
      else if (lower.endsWith(".pdf")) ct = "application/pdf";
      else return null;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    // base64 encode em chunks (evita stack overflow em imagens grandes)
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)) as any);
    }
    const b64 = btoa(bin);
    return `data:${ct};base64,${b64}`;
  } catch {
    return null;
  }
}


async function analyzeReceipt(row: ExpenseRow, apiKey: string): Promise<IAResult> {
  if (!row.attachment_url) {
    return { status: "sem_anexo", notes: "Despesa sem anexo.", extracted_value: null, extracted_merchant: null, extracted_category: null, extracted_date: null };
  }

  const dataUrl = await fetchImageAsDataUrl(row.attachment_url);
  if (!dataUrl) {
    return { status: "erro", notes: "Não foi possível baixar o anexo (formato não suportado ou erro de rede).", extracted_value: null, extracted_merchant: null, extracted_category: null, extracted_date: null };
  }

  const systemPrompt = `Você é um auditor de despesas. Analise a imagem de um comprovante/nota fiscal/cupom e extraia:
- valor total pago (number, em reais)
- nome do estabelecimento
- CNPJ do estabelecimento (somente dígitos, se visível)
- data da transação no formato YYYY-MM-DD (procure por data de emissão, data da compra, data/hora do cupom)
- categoria provável (combustível, hospedagem, alimentação, pedágio, estacionamento, taxi/uber, outros)
Responda APENAS com JSON válido neste schema:
{"valor": number|null, "estabelecimento": string|null, "cnpj": string|null, "data": string|null, "categoria": string|null, "legivel": boolean, "observacao": string}`;

  const userText = `Despesa cadastrada no app:
- Tipo: ${row.type_name ?? "—"}
- Valor: R$ ${(row.amount ?? 0).toFixed(2)}
- Data: ${row.expense_date ?? "—"}
- Descrição: ${row.description ?? "—"}
Analise o comprovante anexado e extraia TODOS os dados (valor, data, estabelecimento, CNPJ, categoria).`;

  try {
    const isPdf = dataUrl.startsWith("data:application/pdf");
    const contentBlock = isPdf
      ? { type: "file", file: { filename: "comprovante.pdf", file_data: dataUrl } }
      : { type: "image_url", image_url: { url: dataUrl } };

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: [{ type: "text", text: userText }, contentBlock] },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (res.status === 429) return { status: "erro", notes: "Rate limit IA. Tente novamente.", extracted_value: null, extracted_merchant: null, extracted_category: null, extracted_date: null };
    if (res.status === 402) return { status: "erro", notes: "Créditos IA esgotados.", extracted_value: null, extracted_merchant: null, extracted_category: null, extracted_date: null };
    if (!res.ok) return { status: "erro", notes: `IA HTTP ${res.status}`, extracted_value: null, extracted_merchant: null, extracted_category: null, extracted_date: null };

    const json = await res.json();
    const raw = json.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }

    const extractedValue: number | null = parsed.valor != null ? Number(parsed.valor) : null;
    const merchant: string | null = parsed.estabelecimento ?? null;
    const categoria: string | null = parsed.categoria ?? null;
    const cnpj: string | null = parsed.cnpj ? String(parsed.cnpj).replace(/\D/g, "") : null;
    const dataMatch = String(parsed.data ?? "").match(/^\d{4}-\d{2}-\d{2}/);
    const extractedDate: string | null = dataMatch ? dataMatch[0] : null;
    const legivel: boolean = parsed.legivel !== false;
    const obs: string = parsed.observacao ?? "";

    if (!legivel || (extractedValue == null && !merchant)) {
      return { status: "ilegivel", notes: obs || "Comprovante ilegível.", extracted_value: extractedValue, extracted_merchant: merchant, extracted_category: categoria, extracted_date: extractedDate };
    }

    // Compara valor
    const expected = Number(row.amount ?? 0);
    let valorDivergente = false;
    if (extractedValue != null && expected > 0) {
      const diff = Math.abs(extractedValue - expected);
      const tol = Math.max(TOLERANCE_ABS, expected * TOLERANCE_PCT);
      if (diff > tol) valorDivergente = true;
    }

    // Compara data
    let dataDivergente = false;
    let diasDiff = 0;
    if (extractedDate && row.expense_date) {
      const d1 = new Date(extractedDate + "T00:00:00Z").getTime();
      const d2 = new Date(row.expense_date + "T00:00:00Z").getTime();
      diasDiff = Math.round(Math.abs(d1 - d2) / 86400000);
      if (diasDiff > DATE_TOLERANCE_DAYS) dataDivergente = true;
    }

    // Compara tipo (heurística por palavras-chave)
    const tipo = (row.type_name ?? "").toLowerCase();
    const cat = (categoria ?? "").toLowerCase();
    const merch = (merchant ?? "").toLowerCase();
    const CATS: Record<string, string[]> = {
      combustivel: ["combust", "posto", "gasolina", "etanol", "diesel", "shell", "ipiranga", "petrobras", "br ", "ale "],
      hospedagem: ["hospedagem", "hotel", "pousada", "hostel", "motel", "airbnb"],
      alimenta: ["alimenta", "refei", "almoço", "almoco", "jantar", "restaur", "lanchonete", "padaria", "ifood", "rappi", "bar ", "café", "cafe", "pizzar", "churras"],
      pedagio: ["pedag", "ccr", "autopista", "ecorodov"],
      estacionamento: ["estacion", "parking", "garagem"],
      taxi: ["uber", "99 ", "taxi", "táxi", "cabify"],
    };
    const findCat = (txt: string): string | null => {
      for (const [k, kws] of Object.entries(CATS)) {
        if (kws.some(kw => txt.includes(kw))) return k;
      }
      return null;
    };
    const tipoEsperado = findCat(tipo);
    const tipoDetectado = findCat(cat) ?? findCat(merch);
    let tipoDivergente = false;
    if (tipoEsperado && tipoDetectado && tipoEsperado !== tipoDetectado) tipoDivergente = true;

    // Prioridade: valor > tipo > data
    let status: IAResult["status"] = "ok";
    const notesArr: string[] = [];
    if (valorDivergente) {
      status = "valor_divergente";
      notesArr.push(`⚠️ Valor cadastrado R$ ${expected.toFixed(2)} vs comprovante R$ ${extractedValue!.toFixed(2)}.`);
    }
    if (tipoDivergente) {
      if (status === "ok") status = "tipo_divergente";
      notesArr.push(`⚠️ Tipo "${row.type_name}" não bate com categoria detectada "${categoria}".`);
    }
    if (dataDivergente) {
      if (status === "ok") status = "data_divergente";
      notesArr.push(`⚠️ Data cadastrada ${row.expense_date} vs comprovante ${extractedDate} (${diasDiff} dias).`);
    }
    if (status === "ok") {
      const parts = [merchant ?? "—", `R$ ${(extractedValue ?? 0).toFixed(2)}`];
      if (extractedDate) parts.push(extractedDate);
      if (cnpj) parts.push(`CNPJ ${cnpj}`);
      notesArr.push(`✓ Confere: ${parts.join(" · ")}.`);
    }
    if (obs) notesArr.push(obs);

    return { status, notes: notesArr.join(" "), extracted_value: extractedValue, extracted_merchant: merchant, extracted_category: categoria, extracted_date: extractedDate };
  } catch (e) {
    return { status: "erro", notes: e instanceof Error ? e.message : String(e), extracted_value: null, extracted_merchant: null, extracted_category: null, extracted_date: null };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "LOVABLE_API_KEY ausente" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
    const onlyMissing: boolean = body.only_missing === true;
    const dataInicio: string | undefined = body.data_inicio;
    const dataFim: string | undefined = body.data_fim;

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let query = supabase
      .from("auvo_expenses_sync")
      .select("id, type_name, amount, description, attachment_url, ai_validation_status")
      .not("attachment_url", "is", null);

    if (ids.length > 0) {
      query = query.in("id", ids);
    } else {
      if (dataInicio) query = query.gte("expense_date", dataInicio);
      if (dataFim) query = query.lte("expense_date", dataFim);
      if (onlyMissing) query = query.is("ai_validation_status", null);
      query = query.limit(200);
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    const results: Array<{ id: string; status: string; notes: string }> = [];
    // Sequencial pra evitar rate limit; com cap razoável
    for (const row of (rows ?? []) as ExpenseRow[]) {
      const r = await analyzeReceipt(row, apiKey);
      await supabase.from("auvo_expenses_sync").update({
        ai_validation_status: r.status,
        ai_validation_notes: r.notes,
        ai_extracted_value: r.extracted_value,
        ai_extracted_merchant: r.extracted_merchant,
        ai_extracted_category: r.extracted_category,
        ai_validated_at: new Date().toISOString(),
      } as any).eq("id", row.id);
      results.push({ id: row.id, status: r.status, notes: r.notes });
    }

    const summary = results.reduce((acc: Record<string, number>, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

    return new Response(JSON.stringify({ analyzed: results.length, summary, results }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
