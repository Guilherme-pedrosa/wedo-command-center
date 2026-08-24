// Worker que consome fin_gc_write_jobs e envia PUT pro GestãoClick.
// Roda em loop interno respeitando rate limit (350ms entre requests ≈ 2.85 req/s, margem sobre 3 req/s do GC).
// Marca status: pendente → processando → sucesso | erro_retentavel | erro_fatal
import { installGcUsuarioId } from "../_shared/gc-user.ts";
import {
  internalProductTax,
  isFiscalOnlyProductPayload,
  mergeGcInternalFiscal,
  prepareGcInternalProductForSave,
  unwrapGcInternalProduct,
} from "../_shared/gc-internal-fiscal.ts";
installGcUsuarioId();

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RATE_LIMIT_MS = 350;
const BATCH_SIZE = 50;
const MAX_RETRIES = 3;
let lastGcCallAt = 0;

interface WriteJob {
  id: string;
  recurso: string;
  recurso_id: string;
  payload: Record<string, unknown>;
  status: string;
  tentativas: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gcFetch(url: string, init: RequestInit): Promise<Response> {
  const elapsed = Date.now() - lastGcCallAt;
  if (elapsed < RATE_LIMIT_MS) await sleep(RATE_LIMIT_MS - elapsed);
  lastGcCallAt = Date.now();
  return fetch(url, init);
}

function numericOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// A API do GC usa envelopes diferentes entre endpoints/versões
// ({data: produto}, {data: {Produto: produto}}, {Produto: produto}).
function unwrapGcProduct(value: unknown): Record<string, unknown> | null {
  let current = asRecord(value);
  for (let i = 0; i < 4 && current; i++) {
    const next = asRecord(current.data) ?? asRecord(current.Produto) ?? asRecord(current.produto);
    if (!next) break;
    current = next;
  }
  return current;
}

function normalizeNcm(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "").slice(0, 8);
}

function productNcm(product: Record<string, unknown> | null): string {
  if (!product) return "";
  const fiscal = asRecord(product.fiscal);
  return normalizeNcm(fiscal?.ncm ?? product.ncm);
}

function normalizeOrigem(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  return /^[0-8]$/.test(raw) ? raw : null;
}

async function requestCanWriteGc(
  req: Request,
  supabaseUrl: string,
  anonKey: string,
  serviceRoleKey: string,
  adminClient: ReturnType<typeof createClient>,
): Promise<boolean> {
  const authorization = req.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  if (authorization === `Bearer ${serviceRoleKey}`) return true;
  if (!anonKey) return false;

  const token = authorization.slice("Bearer ".length).trim();
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) return false;

  const { data: roles, error: roleError } = await adminClient
    .from("user_roles")
    .select("role")
    .eq("user_id", data.user.id)
    .in("role", ["admin", "ceo", "gerente_financeiro"]);
  return !roleError && Boolean(roles?.length);
}

type InternalFiscalResult =
  | {
    ok: true;
    before: string | null;
    ncmAfter: string;
    origemAfter: string;
    productName: string;
  }
  | { ok: false; error: string };

async function updateAndVerifyInternalFiscal(params: {
  produtoId: string;
  ncm: string;
  origem: string;
  sessionToken: string;
}): Promise<InternalFiscalResult> {
  const url = `https://app.api.click.app/produtos/editar/${encodeURIComponent(params.produtoId)}?tab=fiscal`;
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://gestaoclick.com",
    "Referer": "https://gestaoclick.com/",
    "host-origin": "gestaoclick.com",
    "x-token-auth": params.sessionToken,
  };

  try {
    const getRes = await gcFetch(url, { method: "GET", headers });
    const getBody = await getRes.json().catch(() => null);
    const produtoInterno = getRes.ok ? unwrapGcInternalProduct(getBody) : null;
    if (!produtoInterno) {
      const message = String(asRecord(getBody)?.message ?? asRecord(getBody)?.error ?? "cadastro fiscal não retornado");
      return {
        ok: false,
        error: `A sessão autenticada da tela fiscal do GC foi recusada (HTTP ${getRes.status}: ${message}). A conexão técnica da implantação precisa ser renovada.`,
      };
    }

    const tributoAnterior = internalProductTax(produtoInterno);
    if (!tributoAnterior) {
      return { ok: false, error: "GC não devolveu o bloco tributário atual; gravação fiscal abortada." };
    }
    const origemAnterior = normalizeOrigem(tributoAnterior.ICMS_orig);
    const fiscalMerged = mergeGcInternalFiscal(produtoInterno, params.ncm, params.origem);
    const prepared = prepareGcInternalProductForSave(fiscalMerged);
    if (!prepared.ok) return { ok: false, error: prepared.error };

    const postRes = await gcFetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "multipart/form-data" },
      body: JSON.stringify({ data: prepared.payload }),
    });
    const postBody = await postRes.json().catch(() => null);
    const postJson = asRecord(postBody);
    if (!postRes.ok) {
      const message = String(postJson?.message ?? `HTTP ${postRes.status}`);
      return { ok: false, error: `GC recusou a atualização fiscal: ${message}` };
    }

    // O GET é a confirmação real. Repetimos brevemente porque o cadastro do GC
    // pode demorar alguns milissegundos para refletir o POST.
    let verifyStatus = 0;
    let verifyProduto: Record<string, unknown> | null = null;
    let ncmPersistido = "";
    let origemPersistida: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(250);
      const verifyRes = await gcFetch(url, { method: "GET", headers });
      verifyStatus = verifyRes.status;
      const verifyBody = await verifyRes.json().catch(() => null);
      verifyProduto = verifyRes.ok ? unwrapGcInternalProduct(verifyBody) : null;
      const tributoPersistido = internalProductTax(verifyProduto);
      ncmPersistido = normalizeNcm(tributoPersistido?.NCM);
      origemPersistida = normalizeOrigem(tributoPersistido?.ICMS_orig);
      if (
        verifyProduto &&
        (!params.ncm || ncmPersistido === params.ncm) &&
        origemPersistida === params.origem
      ) break;
    }

    if (!verifyProduto) {
      return {
        ok: false,
        error: `GC aceitou o envio, mas a releitura fiscal falhou (HTTP ${verifyStatus}).`,
      };
    }
    if (params.ncm && ncmPersistido !== params.ncm) {
      return {
        ok: false,
        error: `GC respondeu sucesso, mas não gravou o NCM ${params.ncm}. Retorno: ${ncmPersistido || "vazio"}.`,
      };
    }
    if (origemPersistida !== params.origem) {
      return {
        ok: false,
        error: `GC respondeu sucesso, mas não gravou a origem ${params.origem}. Retorno: ${origemPersistida ?? "vazio"}.`,
      };
    }

    const produtoPersistido = asRecord(verifyProduto.Produto);

    return {
      ok: true,
      before: origemAnterior,
      ncmAfter: ncmPersistido,
      origemAfter: origemPersistida,
      productName: String(produtoPersistido?.nome ?? produtoPersistido?.descricao ?? "(sem nome)"),
    };
  } catch (error) {
    return { ok: false, error: `Falha ao acessar o cadastro fiscal do GC: ${(error as Error).message}` };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (!await requestCanWriteGc(req, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, supabase)) {
    return new Response(JSON.stringify({ error: "Sem permissão para alterar o GestãoClick." }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const body = await req.json().catch(() => ({})) as { job_id?: string; job_ids?: string[] };

  const GC_BASE_URL = Deno.env.get("GC_BASE_URL") ?? "https://api.gestaoclick.com";
  const GC_ACCESS_TOKEN = Deno.env.get("GC_ACCESS_TOKEN") ?? "";
  const GC_SECRET_TOKEN = Deno.env.get("GC_SECRET_TOKEN") ?? "";
  // Compatibilidade: versões anteriores já usavam GC_WEB_TOKEN para a sessão
  // técnica do app do GC. O nome novo não pode invalidar um secret existente.
  const GC_FISCAL_SESSION_TOKEN = (
    Deno.env.get("GC_FISCAL_SESSION_TOKEN") ?? Deno.env.get("GC_WEB_TOKEN") ?? ""
  ).trim();

  // 1. Buscar jobs pendentes
  let jobsQuery = supabase
    .from("fin_gc_write_jobs")
    .select("id, recurso, recurso_id, payload, status, tentativas")
    .in("status", ["pendente", "erro_retentavel"])
    .lt("tentativas", MAX_RETRIES);

  if (body.job_id) {
    jobsQuery = jobsQuery.eq("id", body.job_id).limit(1);
  } else if (Array.isArray(body.job_ids) && body.job_ids.length > 0) {
    const jobIds = [...new Set(body.job_ids.map(String))].slice(0, BATCH_SIZE);
    jobsQuery = jobsQuery.in("id", jobIds).limit(BATCH_SIZE);
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
    if (job.recurso === "produtos" || job.recurso === "fin_gc_write_jobs" || job.recurso === "fin_nfe_entrada_itens" || job.recurso === "produto_custo_incremento") {
      url = `${GC_BASE_URL}/api/produtos/${job.recurso_id}`;
      method = "PUT";
    } else if (job.recurso === "fin_pagamentos") {
      url = `${GC_BASE_URL}/api/v1/pagamentos/${job.recurso_id}`;
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
    let verifiedProduto: Record<string, unknown> | null = null;
    let verifiedOrigem: string | null = null;
    let verifiedProductName: string | null = null;
    const fiscalOnlyJob = job.recurso === "produtos" && isFiscalOnlyProductPayload(job.payload);

    try {
      if (fiscalOnlyJob) {
        const ncmSolicitado = normalizeNcm(job.payload.ncm);
        const origemSolicitada = normalizeOrigem(job.payload.origem)!;

        if (job.payload.ncm != null && ncmSolicitado.length !== 8) {
          errorMsg = "NCM fiscal inválido: informe exatamente 8 dígitos.";
          responseBody = { source: "gc_internal_fiscal", invalid_ncm: true };
        } else if (!GC_FISCAL_SESSION_TOKEN) {
          errorMsg = "A sessão autenticada da tela fiscal do GC não está configurada na implantação; a origem não foi alterada.";
          responseBody = { source: "gc_internal_fiscal", configured: false };
        } else {
          const fiscalResult = await updateAndVerifyInternalFiscal({
            produtoId: job.recurso_id,
            ncm: ncmSolicitado,
            origem: origemSolicitada,
            sessionToken: GC_FISCAL_SESSION_TOKEN,
          });

          if (!fiscalResult.ok) {
            errorMsg = fiscalResult.error;
            responseBody = { source: "gc_internal_fiscal", verified: false };
          } else {
            success = true;
            httpStatus = 200;
            verifiedOrigem = fiscalResult.origemAfter;
            verifiedProductName = fiscalResult.productName;
            responseBody = {
              source: "gc_internal_fiscal",
              produto_id: job.recurso_id,
              produto_nome: fiscalResult.productName,
              origem_before: fiscalResult.before,
              _argus_verification: {
                source: "gc_internal_get",
                ncm: fiscalResult.ncmAfter,
                origem: fiscalResult.origemAfter,
                verified_at: new Date().toISOString(),
              },
            };
          }
        }
      } else {
      if (!GC_ACCESS_TOKEN || !GC_SECRET_TOKEN) {
        throw new Error("Credenciais públicas do GestãoClick não configuradas.");
      }
      // ===== GET-before-PUT =====
      // 1. GET produto completo do GC (PUT parcial é rejeitado com HTTP 500)
      const getRes = await gcFetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "access-token": GC_ACCESS_TOKEN,
          "secret-access-token": GC_SECRET_TOKEN,
          "usuario-id": "1320473",
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
      const produtoBase = unwrapGcProduct(getJson);

      if (!produtoBase || !Array.isArray(produtoBase.valores)) {
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
      const payload = job.payload as {
        valor_custo?: string | number;
        valores?: Array<Record<string, unknown>>;
        ncm?: string;
        origem?: string;
      };
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
      const ncmSolicitado = normalizeNcm(payload.ncm);
      const origemSolicitada = normalizeOrigem(payload.origem);
      const fiscalBase = asRecord(produtoBase.fiscal) ?? {};

      // 4. Montar PUT completo
      const putBody = {
        ...produtoBase,
        valor_custo: String(novoCustoTopLevel),
        ...(ncmSolicitado ? { ncm: ncmSolicitado } : {}),
        fiscal: {
          ...fiscalBase,
          ...(ncmSolicitado ? { ncm: ncmSolicitado } : {}),
        },
        valores: valoresMerged,
      };

      // 5. Pequeno respiro entre GET e PUT do mesmo produto
      await sleep(150);

      // 6. PUT
      const response = await gcFetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "access-token": GC_ACCESS_TOKEN,
          "secret-access-token": GC_SECRET_TOKEN,
          "usuario-id": "1320473",
        },
        body: JSON.stringify(putBody),
      });
      httpStatus = response.status;
      responseBody = await response.json().catch(() => null);

      if (response.ok) {
        // HTTP 200 não basta: o GC ignora silenciosamente campos que não aceita.
        // Relê o produto e só confirma a operação se o NCM realmente persistiu.
        await sleep(150);
        const verifyRes = await gcFetch(url, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "access-token": GC_ACCESS_TOKEN,
            "secret-access-token": GC_SECRET_TOKEN,
            "usuario-id": "1320473",
          },
        });
        const verifyBody = await verifyRes.json().catch(() => null);
        verifiedProduto = verifyRes.ok ? unwrapGcProduct(verifyBody) : null;

        if (!verifyRes.ok) {
          errorMsg = `PUT aceito, mas a conferência falhou HTTP ${verifyRes.status}: ${JSON.stringify(verifyBody)}`;
        } else if (ncmSolicitado && productNcm(verifiedProduto) !== ncmSolicitado) {
          errorMsg = `GC respondeu sucesso, mas não gravou o NCM ${ncmSolicitado}. Retorno atual: ${productNcm(verifiedProduto) || "vazio"}`;
        } else if (origemSolicitada && job.recurso === "produtos") {
          if (!GC_FISCAL_SESSION_TOKEN) {
            errorMsg = "NCM gravado, mas a sessão autenticada da tela fiscal do GC não está configurada na implantação; a origem não foi alterada.";
          } else {
            const fiscalResult = await updateAndVerifyInternalFiscal({
              produtoId: job.recurso_id,
              ncm: ncmSolicitado || productNcm(verifiedProduto),
              origem: origemSolicitada,
              sessionToken: GC_FISCAL_SESSION_TOKEN,
            });
            if (!fiscalResult.ok) {
              errorMsg = fiscalResult.error;
            } else {
              success = true;
              verifiedOrigem = fiscalResult.origemAfter;
              verifiedProductName = fiscalResult.productName;
              responseBody = {
                source: "gc_public_then_internal_fiscal",
                produto_id: job.recurso_id,
                gc_response: responseBody,
                _argus_verification: {
                  source: "gc_internal_get",
                  ncm: fiscalResult.ncmAfter,
                  origem: fiscalResult.origemAfter,
                  verified_at: new Date().toISOString(),
                },
              };
            }
          }
        } else {
          success = true;
          responseBody = {
            source: "gc_public",
            gc_response: responseBody,
            _argus_verification: {
              source: "gc_public_get",
              ncm: productNcm(verifiedProduto),
              origem: null,
              verified_at: new Date().toISOString(),
            },
          };
        }
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
      }
    } catch (e) {
      errorMsg = `network: ${(e as Error).message}`;
    }

    if (success) {
      const payload = job.payload as {
        valor_custo?: string | number;
        valores?: Array<Record<string, unknown>>;
        ncm?: string;
        origem?: string;
      };
      const valoresPayload = payload.valores ?? [];
      let cacheSyncError = "";

      if (job.recurso === "produtos") {
        const responseProduto = verifiedProduto ?? (fiscalOnlyJob ? null : unwrapGcProduct(responseBody));
        const { data: cacheRow } = await supabase
          .from("gc_produtos_cache")
          .select("nome, valores, origem")
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
          const { error: cacheError } = await supabase.from("gc_produtos_cache").upsert({
            produto_gc_id: String(responseProduto.id ?? job.recurso_id),
            nome: String(responseProduto.nome ?? "(sem nome)"),
            codigo_interno: responseProduto.codigo_interno ? String(responseProduto.codigo_interno) : null,
            codigo_barra: responseProduto.codigo_barra ? String(responseProduto.codigo_barra) : null,
            nome_grupo: responseProduto.nome_grupo ? String(responseProduto.nome_grupo) : null,
            grupo_id: responseProduto.grupo_id ? String(responseProduto.grupo_id) : null,
            ncm: (responseProduto.fiscal as { ncm?: unknown } | undefined)?.ncm ? String((responseProduto.fiscal as { ncm?: unknown }).ncm) : responseProduto.ncm ? String(responseProduto.ncm) : null,
            // Origem só entra no cache depois da releitura do cadastro fiscal interno.
            origem: verifiedOrigem
              ?? normalizeOrigem((asRecord(responseProduto.fiscal))?.origem ?? responseProduto.origem)
              ?? normalizeOrigem(cacheRow?.origem),
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
          if (cacheError) cacheSyncError = cacheError.message;
        } else {
          const verification = asRecord(asRecord(responseBody)?._argus_verification);
          const { error: cacheError } = await supabase
            .from("gc_produtos_cache")
            .upsert({
              produto_gc_id: job.recurso_id,
              nome: String(verifiedProductName ?? cacheRow?.nome ?? "(sem nome)"),
              valores: valoresAtualizados,
              ...(normalizeNcm(verification?.ncm ?? payload.ncm) ? { ncm: normalizeNcm(verification?.ncm ?? payload.ncm) } : {}),
              ...(verifiedOrigem ? { origem: verifiedOrigem } : {}),
              updated_at: new Date().toISOString(),
              ultima_sincronizacao: new Date().toISOString(),
            }, { onConflict: "produto_gc_id" });
          if (cacheError) cacheSyncError = cacheError.message;
        }
      }

      if (cacheSyncError) {
        const novasTentativas = (job.tentativas ?? 0) + 1;
        const novoStatus = novasTentativas >= MAX_RETRIES ? "erro_fatal" : "erro_retentavel";
        const erro = `GC confirmou a alteração, mas o cache do Argus não foi atualizado: ${cacheSyncError}`;
        const responseComFalhaLocal = {
          ...(asRecord(responseBody) ?? {}),
          cache_sync_error: cacheSyncError,
        };
        await supabase.from("fin_gc_write_jobs").update({
          status: novoStatus,
          ultimo_erro: erro,
          response_body: responseComFalhaLocal as never,
          finalizado_em: novoStatus === "erro_fatal" ? new Date().toISOString() : null,
        }).eq("id", job.id);
        results.push({ id: job.id, status: novoStatus, erro, http: httpStatus });
        await sleep(RATE_LIMIT_MS);
        continue;
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
