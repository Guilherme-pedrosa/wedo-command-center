import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { errorResult, McpToolError, successResult } from "../shared/errors";
import { gcData, gcRequest, queryString } from "../shared/gc-client";
import { centsToMoney, moneyToCents } from "../shared/money";
import {
  claimAction,
  completeAction,
  failAction,
  prepareAction,
} from "../shared/pending-actions";
import { requestIdFrom, runAudited, type AppRole } from "../shared/supabase";

const COMMERCIAL_WRITE_ROLES: readonly AppRole[] = [
  "admin",
  "ceo",
  "gerente_comercial",
  "vendedor",
];

// A API GestãoClick devolve envelopes legados heterogêneos.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

const idSchema = z.string().trim().regex(/^\d+$/).max(30);
const moneySchema = z.union([z.string().trim().min(1).max(40), z.number().finite()]);
const optionalNumber = z.union([z.string().trim().min(1).max(40), z.number().finite()]).optional();

const catalogInputSchema = {
  tipo: z.enum(["produto", "servico"]),
  nome: z.string().trim().min(2).max(160),
  codigo: z.string().trim().min(1).max(80),
  valor_custo: moneySchema.optional(),
  valor_venda: moneySchema.optional(),
  codigo_barra: z.string().trim().max(80).optional(),
  descricao: z.string().trim().max(2000).optional(),
  observacoes: z.string().trim().max(2000).optional(),
  ativo: z.boolean().default(true),
  estoque: z.number().finite().min(0).optional(),
  grupo_id: idSchema.optional(),
  nome_grupo: z.string().trim().max(120).optional(),
  ncm: z.string().trim().max(20).optional(),
  cest: z.string().trim().max(20).optional(),
  largura: optionalNumber,
  altura: optionalNumber,
  comprimento: optionalNumber,
  peso_liquido: optionalNumber,
  peso_bruto: optionalNumber,
  fornecedor_ids: z.array(idSchema).max(50).optional(),
  permitir_nome_duplicado: z.boolean().default(false),
};

function handle<T extends object>(
  ctx: ToolContext,
  options: Parameters<typeof runAudited<T>>[1],
  operation: Parameters<typeof runAudited<T>>[2],
) {
  return runAudited(ctx, options, operation)
    .then(({ data, requestId }) => successResult({ ok: true, request_id: requestId, ...data }))
    .catch((error) => errorResult(error, requestIdFrom(error)));
}

function listFromGc(response: unknown): JsonRecord[] {
  const data = gcData<unknown>(response);
  return Array.isArray(data) ? data : [];
}

function normalizeComparable(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeMoney(value: string | number | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const cents = moneyToCents(value);
  if (cents < 0) {
    throw new McpToolError("INVALID_INPUT", `${field} não pode ser negativo.`);
  }
  return centsToMoney(cents);
}

function normalizeOptionalNumber(value: string | number | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const number = Number(String(value).replace(",", "."));
  if (!Number.isFinite(number) || number < 0) {
    throw new McpToolError("INVALID_INPUT", `${field} deve ser um número não negativo.`);
  }
  return String(number);
}

function catalogPath(tipo: "produto" | "servico"): "/produtos" | "/servicos" {
  return tipo === "produto" ? "/produtos" : "/servicos";
}

function normalizePayload(input: JsonRecord): {
  tipo: "produto" | "servico";
  body: JsonRecord;
  permitir_nome_duplicado: boolean;
} {
  const tipo = input.tipo as "produto" | "servico";
  const valorVenda = normalizeMoney(input.valor_venda, "valor_venda");

  if (tipo === "servico") {
    return {
      tipo,
      permitir_nome_duplicado: Boolean(input.permitir_nome_duplicado),
      body: {
        nome: input.nome,
        codigo: input.codigo,
        ...(valorVenda !== undefined ? { valor_venda: valorVenda } : {}),
        ...(input.observacoes || input.descricao
          ? { observacoes: input.observacoes || input.descricao }
          : {}),
      },
    };
  }

  if (input.valor_custo === undefined) {
    throw new McpToolError(
      "INVALID_INPUT",
      "Para cadastrar produto, informe valor_custo. Nome, código interno e custo são obrigatórios no GestãoClick.",
    );
  }

  const body: JsonRecord = {
    nome: input.nome,
    codigo_interno: input.codigo,
    valor_custo: normalizeMoney(input.valor_custo, "valor_custo"),
    ativo: input.ativo ? "1" : "0",
  };
  if (valorVenda !== undefined) body.valor_venda = valorVenda;
  if (input.codigo_barra) body.codigo_barra = input.codigo_barra;
  if (input.descricao) body.descricao = input.descricao;
  if (input.estoque !== undefined) body.estoque = input.estoque;
  if (input.grupo_id) body.grupo_id = input.grupo_id;
  if (input.nome_grupo) body.nome_grupo = input.nome_grupo;
  if (input.ncm) body.ncm = input.ncm;
  if (input.cest) body.cest = input.cest;
  for (const field of [
    "largura",
    "altura",
    "comprimento",
    "peso_liquido",
    "peso_bruto",
  ]) {
    const value = normalizeOptionalNumber(input[field], field);
    if (value !== undefined) body[field] = value;
  }
  if (input.fornecedor_ids?.length) {
    body.fornecedores = input.fornecedor_ids.map((fornecedorId: string) => ({
      fornecedor_id: fornecedorId,
    }));
  }
  return {
    tipo,
    body,
    permitir_nome_duplicado: Boolean(input.permitir_nome_duplicado),
  };
}

async function ensureCatalogIsUnique(prepared: {
  tipo: "produto" | "servico";
  body: JsonRecord;
  permitir_nome_duplicado: boolean;
}): Promise<void> {
  const { tipo, body } = prepared;
  const codeField = tipo === "produto" ? "codigo_interno" : "codigo";
  const code = String(body[codeField]);
  const path = catalogPath(tipo);

  const byCode = listFromGc(
    await gcRequest<unknown>(`${path}${queryString({ [codeField]: code, limite: 20 })}`),
  ).filter((row) => normalizeComparable(row[codeField]) === normalizeComparable(code));
  if (byCode.length) {
    throw new McpToolError(
      "MULTIPLE_MATCHES",
      `Já existe ${tipo === "produto" ? "um produto" : "um serviço"} com este código no GestãoClick.`,
      false,
      {
        itens: byCode.slice(0, 5).map((row) => ({
          id: String(row.id),
          nome: row.nome,
          codigo: row[codeField],
        })),
      },
    );
  }

  if (prepared.permitir_nome_duplicado) return;
  const byName = listFromGc(
    await gcRequest<unknown>(`${path}${queryString({ nome: body.nome, limite: 20 })}`),
  ).filter((row) => normalizeComparable(row.nome) === normalizeComparable(body.nome));
  if (byName.length) {
    throw new McpToolError(
      "MULTIPLE_MATCHES",
      `Já existe ${tipo === "produto" ? "um produto" : "um serviço"} com este nome. Use o cadastro existente ou permita nome duplicado conscientemente.`,
      false,
      {
        itens: byName.slice(0, 5).map((row) => ({
          id: String(row.id),
          nome: row.nome,
          codigo: row[codeField],
        })),
      },
    );
  }
}

function creationPreview(prepared: {
  tipo: "produto" | "servico";
  body: JsonRecord;
  permitir_nome_duplicado: boolean;
}) {
  const { tipo, body } = prepared;
  return {
    tipo,
    nome: body.nome,
    codigo: tipo === "produto" ? body.codigo_interno : body.codigo,
    valor_custo: body.valor_custo ?? null,
    valor_venda: body.valor_venda ?? null,
    estoque_inicial: body.estoque ?? null,
    ativo: tipo === "produto" ? body.ativo === "1" : true,
    grupo: body.nome_grupo ?? body.grupo_id ?? null,
    fornecedores: Array.isArray(body.fornecedores) ? body.fornecedores.length : 0,
    permitir_nome_duplicado: prepared.permitir_nome_duplicado,
  };
}

export const prepararCriacaoProdutoServico = defineTool({
  name: "preparar_criacao_produto_servico",
  title: "Preparar criação de produto ou serviço no GestãoClick",
  description:
    "Valida o cadastro, bloqueia código ou nome duplicado e gera uma prévia. Não cria o item. Produto exige nome, código interno e custo; serviço exige nome e código. Após confirmação explícita, use confirmar_criacao_produto_servico.",
  inputSchema: catalogInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "preparar_criacao_produto_servico",
        operationType: "prepare",
        sourceSystem: "gestaoclick",
        allowedRoles: COMMERCIAL_WRITE_ROLES,
        parameters: input,
        targetEntity: input.tipo,
      },
      async (actor, requestId) => {
        const prepared = normalizePayload(input);
        await ensureCatalogIsUnique(prepared);
        return prepareAction({
          actor,
          action: "criar_produto_servico_gc",
          payload: prepared,
          requestId,
          preview: creationPreview(prepared),
        });
      },
    ),
});

export const confirmarCriacaoProdutoServico = defineTool({
  name: "confirmar_criacao_produto_servico",
  title: "Confirmar criação de produto ou serviço no GestãoClick",
  description:
    "Cria exatamente o produto ou serviço previamente preparado. Só use depois da confirmação explícita do usuário na conversa.",
  inputSchema: {
    pending_action_id: z.string().uuid(),
    confirmation_token: z.string().length(64),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "confirmar_criacao_produto_servico",
        operationType: "write",
        sourceSystem: "gestaoclick",
        allowedRoles: COMMERCIAL_WRITE_ROLES,
        parameters: { pending_action_id: input.pending_action_id },
        targetEntity: "catalogo",
      },
      async (actor) => {
        const claimed = await claimAction({
          actor,
          actionId: input.pending_action_id,
          confirmationToken: input.confirmation_token,
          expectedAction: "criar_produto_servico_gc",
        });
        try {
          const prepared = claimed.payload as {
            tipo: "produto" | "servico";
            body: JsonRecord;
            permitir_nome_duplicado: boolean;
          };
          if (!prepared?.body?.nome || !["produto", "servico"].includes(prepared.tipo)) {
            throw new McpToolError("CONFIRMATION_INVALID", "O cadastro preparado é inválido.");
          }
          await ensureCatalogIsUnique(prepared);
          const response = await gcRequest<unknown>(
            catalogPath(prepared.tipo),
            "POST",
            prepared.body,
          );
          const created = gcData<JsonRecord>(response);
          if (!created?.id) {
            throw new McpToolError(
              "GC_UNAVAILABLE",
              "O GestãoClick respondeu sem o ID do item criado. Não tente novamente automaticamente.",
            );
          }
          await completeAction(input.pending_action_id, {
            user_id: actor.id,
            tool_name: "criar_produto_servico_gc",
            payload_hash: claimed.payloadHash,
            upstream_id: String(created.id),
          });
          return {
            created: true,
            tipo: prepared.tipo,
            id: String(created.id),
            nome: created.nome ?? prepared.body.nome,
            codigo:
              created.codigo_interno ??
              created.codigo ??
              prepared.body.codigo_interno ??
              prepared.body.codigo,
            source: "gestaoclick_live",
          };
        } catch (error) {
          await failAction(input.pending_action_id, error);
          throw error;
        }
      },
    ),
});

export const gcCatalogWriteTools = [
  prepararCriacaoProdutoServico,
  confirmarCriacaoProdutoServico,
];
