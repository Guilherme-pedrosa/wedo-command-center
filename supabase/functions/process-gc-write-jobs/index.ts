// Worker que consome fin_gc_write_jobs e envia PUT pro GestãoClick.
// Roda em loop interno respeitando rate limit (350ms entre requests ≈ 2.85 req/s, margem sobre 3 req/s do GC).
// Marca status: pendente → processando → sucesso | erro_retentavel | erro_fatal
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RATE_LIMIT_MS = 350;
const BATCH_SIZE = 50;
const MAX_RETRIES = 3;

interface WriteJob {
  id: string;
  recurso: string;
  recurso_id: string;
  payload: Record<string, unknown>;
  status: string;
  tentativas: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function numericOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const body = await req.json().catch(() => ({})) as { job_id?: string };

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const GC_BASE_URL = Deno.env.get("GC_BASE_URL") ?? "https://api.gestaoclick.com";
  const GC_ACCESS_TOKEN = Deno.env.get("GC_ACCESS_TOKEN");
  const GC_SECRET_TOKEN = Deno.env.get("GC_SECRET_TOKEN");

  if (!GC_ACCESS_TOKEN || !GC_SECRET_TOKEN) {
    return new Response(
      JSON.stringify({ error: "GC credentials not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // 1. Buscar jobs pendentes
  let jobsQuery = supabase
    .from("fin_gc_write_jobs")
    .select("id, recurso, recurso_id, payload, status, tentativas")
    .in("status", ["pendente", "erro_retentavel"])
    .lt("tentativas", MAX_RETRIES);

  if (body.job_id) {
    jobsQuery = jobsQuery.eq("id", body.job_id).limit(1);
  } else {
    jobsQuery = jobsQuery
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  }

  const { data: jobs, error: errJobs } = await jobsQuery;

  if (errJobs) {
    return new Response(JSON.stringify({ error: errJobs.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!jobs || jobs.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, processed: 0, message: "fila vazia" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const results: unknown[] = [];

  for (const job of jobs as WriteJob[]) {
    // Lock otimista: só processa se ainda estiver no status que pegamos
    const { error: errLock, data: lockData } = await supabase
      .from("fin_gc_write_jobs")
      .update({
        status: "processando",
        tentativas: (job.tentativas ?? 0) + 1,
        processado_em: new Date().toISOString(),
        iniciado_em: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", job.status)
      .select("id");

    if (errLock || !lockData || lockData.length === 0) {
      results.push({ id: job.id, status: "skip_lock_failed" });
      continue;
    }

    // Endpoint/método por recurso
    let url: string;
    let method: string;
    if (job.recurso === "produtos") {
      url = `${GC_BASE_URL}/api/produtos/${job.recurso_id}`;
      method = "PUT";
    } else {
      await supabase.from("fin_gc_write_jobs").update({
        status: "erro_fatal",
        ultimo_erro: `recurso não suportado: ${job.recurso}`,
        finalizado_em: new Date().toISOString(),
      }).eq("id", job.id);
      results.push({ id: job.id, status: "erro_fatal_recurso_desconhecido" });
      continue;
    }

    let success = false;
    let errorMsg = "";
    let responseBody: unknown = null;
    let httpStatus = 0;

    try {
      // ===== GET-before-PUT =====
      // 1. GET produto completo do GC (PUT parcial é rejeitado com HTTP 500)
      const getRes = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "access-token": GC_ACCESS_TOKEN,
          "secret-access-token": GC_SECRET_TOKEN,
        },
      });

      if (!getRes.ok) {
        const getBody = await getRes.json().catch(() => null);
        const errMsg = `GET pré-PUT falhou HTTP ${getRes.status}: ${JSON.stringify(getBody)}`;
        const isRetentavel = getRes.status === 429 || getRes.status >= 500;
        const novasTentativas = (job.tentativas ?? 0) + 1;
        const novoStatus = !isRetentavel
          ? "erro_fatal"
          : novasTentativas >= MAX_RETRIES
          ? "erro_fatal"
          : "erro_retentavel";
        await supabase.from("fin_gc_write_jobs").update({
          status: novoStatus,
          ultimo_erro: errMsg,
          response_body: getBody as never,
          finalizado_em: novoStatus === "erro_fatal" ? new Date().toISOString() : null,
        }).eq("id", job.id);
        results.push({ id: job.id, status: novoStatus, erro: errMsg, http: getRes.status });
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      const getJson = await getRes.json();
      const produtoBase = (getJson?.data ?? getJson) as Record<string, unknown>;

      if (!Array.isArray((produtoBase as { valores?: unknown }).valores)) {
        const errMsg = "GET retornou produto sem campo 'valores' (array). Anormal.";
        await supabase.from("fin_gc_write_jobs").update({
          status: "erro_fatal",
          ultimo_erro: errMsg,
          response_body: getJson as never,
          finalizado_em: new Date().toISOString(),
        }).eq("id", job.id);
        results.push({ id: job.id, status: "erro_fatal", erro: errMsg });
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      // 2. Mesclar payload do job (mínimo) com produto completo do GC
      const payload = job.payload as { valor_custo?: string | number; valores?: Array<Record<string, unknown>> };
      const valoresPayload = payload.valores ?? [];
      const tiposAlterados = new Set<string>();
      const valoresMerged = (produtoBase.valores as Array<Record<string, unknown>>).map((vBase) => {
        const override = valoresPayload.find(
          (vp) => String(vp.tipo_id) === String(vBase.tipo_id),
        );
        if (!override) return vBase; // tabela não tocada, manter exatamente como o GC retornou
        tiposAlterados.add(String(vBase.tipo_id));
        // OMITIR lucro_utilizado (read-only no GC)
        const { lucro_utilizado: _ignored, ...semLucro } = vBase as Record<string, unknown>;
        return {
          ...semLucro,
          ...override,
          valor_custo: "0.00", // entradas sempre "0.00"; custo real vai no top-level
        };
      });

      for (const override of valoresPayload) {
        if (!tiposAlterados.has(String(override.tipo_id))) {
          valoresMerged.push({ ...override, valor_custo: "0.00" });
        }
      }

      // 3. Custo top-level: do payload, fallback pro atual do GC
      const novoCustoTopLevel = payload.valor_custo ?? produtoBase.valor_custo;

      // 4. Montar PUT completo
      const putBody = {
        ...produtoBase,
        valor_custo: String(novoCustoTopLevel),
        valores: valoresMerged,
      };

      // 5. Pequeno respiro entre GET e PUT do mesmo produto
      await sleep(150);

      // 6. PUT
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "access-token": GC_ACCESS_TOKEN,
          "secret-access-token": GC_SECRET_TOKEN,
        },
        body: JSON.stringify(putBody),
      });
      httpStatus = response.status;
      responseBody = await response.json().catch(() => null);

      if (response.ok) {
        success = true;
      } else if (response.status === 429 || response.status >= 500) {
        errorMsg = `HTTP ${response.status}: ${JSON.stringify(responseBody)}`;
      } else {
        // 4xx (não 429) = fatal
        await supabase.from("fin_gc_write_jobs").update({
          status: "erro_fatal",
          ultimo_erro: `HTTP ${response.status}: ${JSON.stringify(responseBody)}`,
          response_body: responseBody as never,
          finalizado_em: new Date().toISOString(),
        }).eq("id", job.id);
        results.push({ id: job.id, status: "erro_fatal_4xx", http: response.status });
        await sleep(RATE_LIMIT_MS);
        continue;
      }
    } catch (e) {
      errorMsg = `network: ${(e as Error).message}`;
    }

    if (success) {
      const payload = job.payload as { valor_custo?: string | number; valores?: Array<Record<string, unknown>> };
      const valoresPayload = payload.valores ?? [];

      if (job.recurso === "produtos") {
        const responseProduto = (responseBody as { data?: Record<string, unknown> } | null)?.data;
        const { data: cacheRow } = await supabase
          .from("gc_produtos_cache")
          .select("valores")
          .eq("produto_gc_id", job.recurso_id)
          .maybeSingle();

        const valoresDoGc = Array.isArray(responseProduto?.valores)
          ? responseProduto.valores as Array<Record<string, unknown>>
          : [];
        const valoresAtuais = valoresDoGc.length > 0
          ? valoresDoGc
          : Array.isArray(cacheRow?.valores) ? cacheRow.valores as Array<Record<string, unknown>> : [];
        const tiposAlterados = new Set<string>();
        const valoresAtualizados = valoresAtuais.map((vBase) => {
          const override = valoresPayload.find((vp) => String(vp.tipo_id) === String(vBase.tipo_id));
          if (!override) return vBase;
          tiposAlterados.add(String(vBase.tipo_id));
          return { ...vBase, ...override };
        });

        for (const override of valoresPayload) {
          if (!tiposAlterados.has(String(override.tipo_id))) valoresAtualizados.push(override);
        }

        if (responseProduto) {
          await supabase.from("gc_produtos_cache").upsert({
            produto_gc_id: String(responseProduto.id ?? job.recurso_id),
            nome: String(responseProduto.nome ?? "(sem nome)"),
            codigo_interno: responseProduto.codigo_interno ? String(responseProduto.codigo_interno) : null,
            codigo_barra: responseProduto.codigo_barra ? String(responseProduto.codigo_barra) : null,
            nome_grupo: responseProduto.nome_grupo ? String(responseProduto.nome_grupo) : null,
            grupo_id: responseProduto.grupo_id ? String(responseProduto.grupo_id) : null,
            ncm: (responseProduto.fiscal as { ncm?: unknown } | undefined)?.ncm ? String((responseProduto.fiscal as { ncm?: unknown }).ncm) : responseProduto.ncm ? String(responseProduto.ncm) : null,
            unidade: responseProduto.unidade ? String(responseProduto.unidade) : null,
            estoque: numericOrNull(responseProduto.estoque),
            valor_custo: numericOrNull(responseProduto.valor_custo),
            valor_venda_padrao: numericOrNull(responseProduto.valor_venda),
            valores: valoresAtualizados,
            possui_variacao: responseProduto.possui_variacao === "1" || responseProduto.possui_variacao === true,
            possui_composicao: responseProduto.possui_composicao === "1" || responseProduto.possui_composicao === true,
            movimenta_estoque: responseProduto.movimenta_estoque !== "0" && responseProduto.movimenta_estoque !== false,
            peso: numericOrNull(responseProduto.peso),
            ativo: responseProduto.ativo !== "0" && responseProduto.ativo !== false && responseProduto.ativo !== 0,
            raw_gc: responseProduto as never,
            ultima_sincronizacao: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: "produto_gc_id" });
        } else {
          await supabase
            .from("gc_produtos_cache")
            .update({ valores: valoresAtualizados, updated_at: new Date().toISOString() })
            .eq("produto_gc_id", job.recurso_id);
        }
      }

      await supabase.from("fin_gc_write_jobs").update({
        status: "sucesso",
        ultimo_erro: null,
        response_body: responseBody as never,
        finalizado_em: new Date().toISOString(),
      }).eq("id", job.id);
      results.push({ id: job.id, status: "sucesso", recurso_id: job.recurso_id, http: httpStatus });
    } else {
      const novasTentativas = (job.tentativas ?? 0) + 1;
      const novoStatus = novasTentativas >= MAX_RETRIES ? "erro_fatal" : "erro_retentavel";
      await supabase.from("fin_gc_write_jobs").update({
        status: novoStatus,
        ultimo_erro: errorMsg,
        response_body: responseBody as never,
        finalizado_em: novoStatus === "erro_fatal" ? new Date().toISOString() : null,
      }).eq("id", job.id);
      results.push({ id: job.id, status: novoStatus, erro: errorMsg, http: httpStatus });
    }

    await sleep(RATE_LIMIT_MS);
  }

  const sucessos = results.filter((r) => (r as { status: string }).status === "sucesso").length;
  return new Response(
    JSON.stringify({ ok: true, processed: jobs.length, sucessos, results }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
