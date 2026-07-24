import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { errorResult, McpToolError, successResult } from "../shared/errors";
import { gcData, gcRequest, queryString } from "../shared/gc-client";
import {
  canonicalJson,
  claimAction,
  completeAction,
  failAction,
  prepareAction,
} from "../shared/pending-actions";
import {
  requestIdFrom,
  runAudited,
  type AppRole,
} from "../shared/supabase";

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
const optionalText = (max: number) => z.string().trim().max(max).optional();
const emailSchema = z
  .union([z.literal(""), z.string().trim().email().max(160)])
  .optional();
const dateSchema = z.union([z.literal(""), z.string().date()]).optional();
const stateSchema = z
  .union([z.literal(""), z.string().trim().regex(/^[A-Za-z]{2}$/)])
  .optional();

const contactSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  contato: z.string().trim().min(3).max(160),
  cargo: optionalText(100),
  observacao: optionalText(500),
});

const addressSchema = z.object({
  cep: optionalText(12),
  logradouro: optionalText(160),
  numero: optionalText(30),
  complemento: optionalText(100),
  bairro: optionalText(100),
  cidade_id: idSchema.optional(),
  nome_cidade: optionalText(120),
  estado: stateSchema,
});

const clientOptionalShape = {
  razao_social: optionalText(160),
  cnpj: optionalText(24),
  inscricao_estadual: optionalText(40),
  inscricao_municipal: optionalText(40),
  cpf: optionalText(20),
  rg: optionalText(30),
  data_nascimento: dateSchema,
  telefone: optionalText(30),
  celular: optionalText(30),
  fax: optionalText(30),
  email: emailSchema,
  ativo: z.boolean().optional(),
  usuario_id: idSchema.optional(),
  loja_id: idSchema.optional(),
  contatos: z.array(contactSchema).max(20).optional(),
  enderecos: z.array(addressSchema).max(10).optional(),
};

const WRITABLE_FIELDS = [
  "tipo_pessoa",
  "nome",
  "razao_social",
  "cnpj",
  "inscricao_estadual",
  "inscricao_municipal",
  "cpf",
  "rg",
  "data_nascimento",
  "telefone",
  "celular",
  "fax",
  "email",
  "ativo",
  "usuario_id",
  "loja_id",
  "contatos",
  "enderecos",
] as const;

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

function normalizeDocument(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function maskDocument(value: unknown): string | null {
  const digits = normalizeDocument(value);
  if (!digits) return null;
  if (digits.length <= 5) return "***";
  return `${digits.slice(0, 2)}***${digits.slice(-3)}`;
}

function normalizeClientPatch(input: JsonRecord): JsonRecord {
  const patch: JsonRecord = {};
  for (const field of WRITABLE_FIELDS) {
    if (input[field] !== undefined) patch[field] = input[field];
  }
  if (input.ativo !== undefined) patch.ativo = input.ativo ? "1" : "0";
  if (input.contatos !== undefined) {
    patch.contatos = input.contatos.map((contato: JsonRecord) => ({ contato }));
  }
  if (input.enderecos !== undefined) {
    patch.enderecos = input.enderecos.map((endereco: JsonRecord) => ({
      endereco: {
        ...endereco,
        ...(endereco.estado ? { estado: String(endereco.estado).toUpperCase() } : {}),
      },
    }));
  }
  return patch;
}

function validatePersonDocument(payload: JsonRecord): void {
  const type = String(payload.tipo_pessoa ?? "");
  if (type === "PF" && normalizeDocument(payload.cnpj)) {
    throw new McpToolError(
      "INVALID_INPUT",
      "Cliente pessoa física não pode receber CNPJ. Informe CPF ou deixe o documento vazio.",
    );
  }
  if (type === "PJ" && normalizeDocument(payload.cpf)) {
    throw new McpToolError(
      "INVALID_INPUT",
      "Cliente pessoa jurídica não pode receber CPF. Informe CNPJ ou deixe o documento vazio.",
    );
  }
}

function documentFor(payload: JsonRecord): string {
  return normalizeDocument(payload.cnpj) || normalizeDocument(payload.cpf);
}

async function ensureDocumentIsUnique(
  payload: JsonRecord,
  excludeClientId?: string,
): Promise<void> {
  const document = documentFor(payload);
  if (!document) return;
  const response = await gcRequest<unknown>(
    `/clientes${queryString({ cpf_cnpj: document, limite: 20 })}`,
  );
  const duplicates = listFromGc(response).filter(
    (row) =>
      String(row.id) !== excludeClientId &&
      (normalizeDocument(row.cnpj) === document || normalizeDocument(row.cpf) === document),
  );
  if (duplicates.length) {
    throw new McpToolError(
      "MULTIPLE_MATCHES",
      "Já existe outro cliente no GestãoClick com este CPF/CNPJ. Use a edição do cadastro existente.",
      false,
      {
        clientes: duplicates.slice(0, 5).map((row) => ({
          id: String(row.id),
          nome: row.nome,
          documento_mascarado: maskDocument(row.cnpj ?? row.cpf),
        })),
      },
    );
  }
}

function currentWritableClient(row: JsonRecord): JsonRecord {
  return Object.fromEntries(
    WRITABLE_FIELDS.flatMap((field) =>
      row[field] === undefined ? [] : [[field, row[field]]],
    ),
  );
}

function comparable(value: unknown): string {
  return canonicalJson(value === undefined ? null : value);
}

function previewValue(field: string, value: unknown): unknown {
  if (field === "cpf" || field === "cnpj") return maskDocument(value);
  if (field === "contatos" || field === "enderecos") {
    return { quantidade: Array.isArray(value) ? value.length : 0 };
  }
  return value ?? null;
}

function creationPreview(payload: JsonRecord) {
  return {
    tipo_pessoa: payload.tipo_pessoa,
    nome: payload.nome,
    razao_social: payload.razao_social || null,
    documento_mascarado: maskDocument(payload.cnpj || payload.cpf),
    email: payload.email || null,
    telefone: payload.telefone || payload.celular || null,
    ativo: String(payload.ativo ?? "1") !== "0",
    loja_id: payload.loja_id ?? "matriz/padrão da credencial",
    usuario_id: payload.usuario_id ?? "usuário master/padrão da credencial",
    contatos: Array.isArray(payload.contatos) ? payload.contatos.length : 0,
    enderecos: Array.isArray(payload.enderecos) ? payload.enderecos.length : 0,
  };
}

function changedFieldsPreview(
  current: JsonRecord,
  patch: JsonRecord,
): Record<string, { antes: unknown; depois: unknown }> {
  return Object.fromEntries(
    Object.entries(patch)
      .filter(([field, value]) => comparable(current[field]) !== comparable(value))
      .map(([field, value]) => [
        field,
        {
          antes: previewValue(field, current[field]),
          depois: previewValue(field, value),
        },
      ]),
  );
}

export const prepararCriacaoCliente = defineTool({
  name: "preparar_criacao_cliente",
  title: "Preparar criação de cliente no GestãoClick",
  description:
    "Valida os dados, verifica CPF/CNPJ duplicado e gera uma prévia. Não cria o cliente. Após a confirmação explícita do usuário, use confirmar_criacao_cliente.",
  inputSchema: {
    tipo_pessoa: z.enum(["PF", "PJ", "ES"]),
    nome: z.string().trim().min(2).max(160),
    ...clientOptionalShape,
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
        toolName: "preparar_criacao_cliente",
        operationType: "prepare",
        sourceSystem: "gestaoclick",
        allowedRoles: COMMERCIAL_WRITE_ROLES,
        parameters: input,
        targetEntity: "cliente",
      },
      async (actor, requestId) => {
        const payload = normalizeClientPatch(input);
        if (payload.ativo === undefined) payload.ativo = "1";
        validatePersonDocument(payload);
        await ensureDocumentIsUnique(payload);
        return prepareAction({
          actor,
          action: "criar_cliente_gc",
          payload,
          requestId,
          preview: creationPreview(payload),
        });
      },
    ),
});

export const confirmarCriacaoCliente = defineTool({
  name: "confirmar_criacao_cliente",
  title: "Confirmar criação de cliente no GestãoClick",
  description:
    "Cria exatamente o cliente previamente preparado. Só use após confirmação explícita do usuário na conversa.",
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
        toolName: "confirmar_criacao_cliente",
        operationType: "write",
        sourceSystem: "gestaoclick",
        allowedRoles: COMMERCIAL_WRITE_ROLES,
        parameters: { pending_action_id: input.pending_action_id },
        targetEntity: "cliente",
      },
      async (actor) => {
        const claimed = await claimAction({
          actor,
          actionId: input.pending_action_id,
          confirmationToken: input.confirmation_token,
          expectedAction: "criar_cliente_gc",
        });
        try {
          const payload = claimed.payload as JsonRecord;
          validatePersonDocument(payload);
          await ensureDocumentIsUnique(payload);
          const response = await gcRequest<unknown>("/clientes", "POST", payload);
          const created = gcData<JsonRecord>(response);
          if (!created?.id) {
            throw new McpToolError(
              "GC_UNAVAILABLE",
              "O GestãoClick respondeu sem o ID do cliente. Não tente novamente automaticamente.",
            );
          }
          await completeAction(input.pending_action_id, {
            user_id: actor.id,
            tool_name: "criar_cliente_gc",
            payload_hash: claimed.payloadHash,
            upstream_id: String(created.id),
          });
          return {
            created: true,
            cliente_id: String(created.id),
            nome: created.nome ?? payload.nome,
            source: "gestaoclick_live",
          };
        } catch (error) {
          await failAction(input.pending_action_id, error);
          throw error;
        }
      },
    ),
});

export const prepararEdicaoCliente = defineTool({
  name: "preparar_edicao_cliente",
  title: "Preparar edição de cliente no GestãoClick",
  description:
    "Busca o cadastro atual, valida as alterações e gera uma prévia antes/depois. Não altera o cliente. Após confirmação explícita, use confirmar_edicao_cliente.",
  inputSchema: {
    cliente_id: idSchema,
    tipo_pessoa: z.enum(["PF", "PJ", "ES"]).optional(),
    nome: z.string().trim().min(2).max(160).optional(),
    ...clientOptionalShape,
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
        toolName: "preparar_edicao_cliente",
        operationType: "prepare",
        sourceSystem: "gestaoclick",
        allowedRoles: COMMERCIAL_WRITE_ROLES,
        parameters: input,
        targetEntity: "cliente",
      },
      async (actor, requestId) => {
        const current = gcData<JsonRecord>(
          await gcRequest<unknown>(`/clientes/${input.cliente_id}`),
        );
        if (!current?.id) throw new McpToolError("NOT_FOUND", "Cliente não encontrado.");

        const patch = normalizeClientPatch(input);
        delete patch.cliente_id;
        if (!Object.keys(patch).length) {
          throw new McpToolError("INVALID_INPUT", "Informe ao menos um campo para alterar.");
        }
        const changes = changedFieldsPreview(current, patch);
        if (!Object.keys(changes).length) {
          throw new McpToolError(
            "INVALID_INPUT",
            "Os valores informados já são iguais aos dados atuais do cliente.",
          );
        }

        const merged = { ...currentWritableClient(current), ...patch };
        validatePersonDocument(merged);
        await ensureDocumentIsUnique(merged, input.cliente_id);
        const base = Object.fromEntries(
          Object.keys(patch).map((field) => [field, current[field] ?? null]),
        );

        return prepareAction({
          actor,
          action: "editar_cliente_gc",
          payload: { cliente_id: input.cliente_id, patch, base },
          requestId,
          preview: {
            cliente: { id: input.cliente_id, nome: current.nome },
            alteracoes: changes,
          },
        });
      },
    ),
});

export const confirmarEdicaoCliente = defineTool({
  name: "confirmar_edicao_cliente",
  title: "Confirmar edição de cliente no GestãoClick",
  description:
    "Aplica exatamente as alterações previamente preparadas. Recusa a gravação se os mesmos campos tiverem mudado depois da prévia.",
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
        toolName: "confirmar_edicao_cliente",
        operationType: "write",
        sourceSystem: "gestaoclick",
        allowedRoles: COMMERCIAL_WRITE_ROLES,
        parameters: { pending_action_id: input.pending_action_id },
        targetEntity: "cliente",
      },
      async (actor) => {
        const claimed = await claimAction({
          actor,
          actionId: input.pending_action_id,
          confirmationToken: input.confirmation_token,
          expectedAction: "editar_cliente_gc",
        });
        try {
          const prepared = claimed.payload as {
            cliente_id: string;
            patch: JsonRecord;
            base: JsonRecord;
          };
          const current = gcData<JsonRecord>(
            await gcRequest<unknown>(`/clientes/${prepared.cliente_id}`),
          );
          if (!current?.id) throw new McpToolError("NOT_FOUND", "Cliente não encontrado.");

          const staleFields = Object.keys(prepared.base).filter(
            (field) => comparable(current[field]) !== comparable(prepared.base[field]),
          );
          if (staleFields.length) {
            throw new McpToolError(
              "IDEMPOTENCY_CONFLICT",
              "O cliente mudou depois da prévia. Prepare a edição novamente para não sobrescrever dados recentes.",
              false,
              { campos_alterados: staleFields },
            );
          }

          const updatePayload = {
            ...currentWritableClient(current),
            ...prepared.patch,
          };
          if (!updatePayload.tipo_pessoa || !updatePayload.nome) {
            throw new McpToolError(
              "GC_VALIDATION_ERROR",
              "O cadastro atual não contém tipo de pessoa e nome válidos.",
            );
          }
          validatePersonDocument(updatePayload);
          await ensureDocumentIsUnique(updatePayload, prepared.cliente_id);
          const response = await gcRequest<unknown>(
            `/clientes/${prepared.cliente_id}`,
            "PUT",
            updatePayload,
          );
          const updated = gcData<JsonRecord>(response);
          if (!updated?.id) {
            throw new McpToolError(
              "GC_UNAVAILABLE",
              "O GestãoClick respondeu sem confirmar o cliente atualizado. Não tente novamente automaticamente.",
            );
          }
          await completeAction(input.pending_action_id, {
            user_id: actor.id,
            tool_name: "editar_cliente_gc",
            payload_hash: claimed.payloadHash,
            upstream_id: String(updated.id),
          });
          return {
            updated: true,
            cliente_id: String(updated.id),
            nome: updated.nome ?? updatePayload.nome,
            campos_alterados: Object.keys(prepared.patch),
            source: "gestaoclick_live",
          };
        } catch (error) {
          await failAction(input.pending_action_id, error);
          throw error;
        }
      },
    ),
});

export const gcClientWriteTools = [
  prepararCriacaoCliente,
  confirmarCriacaoCliente,
  prepararEdicaoCliente,
  confirmarEdicaoCliente,
];
