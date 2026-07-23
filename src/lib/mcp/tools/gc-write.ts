import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { errorResult, McpToolError, successResult } from "../shared/errors";
import { gcData, gcRequest } from "../shared/gc-client";
import { centsToMoney, moneyToCents } from "../shared/money";
import {
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
const OS_WRITE_ROLES: readonly AppRole[] = ["admin", "ceo"];
// A API GestãoClick devolve envelopes legados heterogêneos; o tipo dinâmico fica na borda.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;
type GcItem = {
  id: string;
  quantidade: number;
  valor_unitario: string | number;
  detalhes?: string;
};

const itemSchema = z.object({
  id: z.string().trim().regex(/^\d+$/).max(30),
  quantidade: z.number().positive().max(100000),
  valor_unitario: z.union([z.string().trim().min(1).max(30), z.number().nonnegative()]),
  detalhes: z.string().trim().max(500).optional(),
});

function handle<T extends object>(
  ctx: ToolContext,
  options: Parameters<typeof runAudited<T>>[1],
  operation: Parameters<typeof runAudited<T>>[2],
) {
  return runAudited(ctx, options, operation)
    .then(({ data, requestId }) => successResult({ ok: true, request_id: requestId, ...data }))
    .catch((error) => errorResult(error, requestIdFrom(error)));
}

function buildLines(
  items: Array<{ id: string; quantidade: number; valor_unitario: string | number; detalhes?: string }>,
  kind: "produto" | "servico",
) {
  return items.map((item) => {
    const unitCents = moneyToCents(item.valor_unitario);
    if (unitCents < 0) throw new McpToolError("INVALID_INPUT", "Valor unitário não pode ser negativo.");
    const totalCents = Math.round(item.quantidade * unitCents);
    const row = {
      [`${kind}_id`]: item.id,
      quantidade: String(item.quantidade),
      valor_venda: centsToMoney(unitCents),
      valor_total: centsToMoney(totalCents),
      detalhes: item.detalhes ?? "",
      tipo_desconto: "R$",
      desconto_valor: "0.00",
      desconto_porcentagem: "0.00",
    };
    return { [kind]: row };
  });
}

function totalCents(
  items: Array<{ quantidade: number; valor_unitario: string | number }>,
): number {
  return items.reduce(
    (sum, item) => sum + Math.round(item.quantidade * moneyToCents(item.valor_unitario)),
    0,
  );
}

async function resolvePreview(options: {
  clienteId: string;
  situacaoId: string;
  situationKind: "orcamento" | "os";
  produtos: Array<{ id: string; quantidade: number; valor_unitario: string | number }>;
  servicos: Array<{ id: string; quantidade: number; valor_unitario: string | number }>;
}) {
  const client = gcData<JsonRecord>(
    await gcRequest<unknown>(`/clientes/${options.clienteId}`),
  );
  if (!client?.id) throw new McpToolError("NOT_FOUND", "Cliente não encontrado no GestãoClick.");

  const situationResponse = await gcRequest<unknown>(
    options.situationKind === "orcamento"
      ? "/api/situacoes_orcamentos?limite=100"
      : "/api/situacoes_ordens_servicos?limite=100",
  );
  const situationData = gcData<unknown>(situationResponse);
  const situations = Array.isArray(situationData) ? situationData : [];
  const situation = situations.find(
    (row) =>
      row !== null &&
      typeof row === "object" &&
      String((row as { id?: unknown }).id) === options.situacaoId,
  ) as { nome?: unknown; descricao?: unknown } | undefined;
  if (!situation) {
    throw new McpToolError(
      "INVALID_INPUT",
      `Situação ${options.situacaoId} não é válida para ${options.situationKind === "orcamento" ? "orçamento" : "ordem de serviço"}.`,
    );
  }

  const products = [];
  for (const item of options.produtos) {
    const product = gcData<JsonRecord>(
      await gcRequest<unknown>(`/api/produtos/${item.id}`),
    );
    if (!product?.id) throw new McpToolError("NOT_FOUND", `Produto ${item.id} não encontrado.`);
    if (String(product.ativo) === "0" || product.ativo === false) {
      throw new McpToolError("INVALID_INPUT", `Produto ${product.nome ?? item.id} está inativo.`);
    }
    products.push({
      id: item.id,
      nome: product.nome,
      quantidade: item.quantidade,
      valor_unitario: centsToMoney(moneyToCents(item.valor_unitario)),
      estoque_atual: product.estoque ?? null,
    });
  }

  const services = [];
  for (const item of options.servicos) {
    const service = gcData<JsonRecord>(await gcRequest<unknown>(`/servicos/${item.id}`));
    if (!service?.id) throw new McpToolError("NOT_FOUND", `Serviço ${item.id} não encontrado.`);
    if (String(service.ativo) === "0" || service.ativo === false) {
      throw new McpToolError("INVALID_INPUT", `Serviço ${service.nome ?? item.id} está inativo.`);
    }
    services.push({
      id: item.id,
      nome: service.nome,
      quantidade: item.quantidade,
      valor_unitario: centsToMoney(moneyToCents(item.valor_unitario)),
    });
  }

  return {
    cliente: { id: String(client.id), nome: client.nome },
    situacao: {
      id: options.situacaoId,
      nome: situation?.nome ?? situation?.descricao ?? "ID informado",
    },
    produtos: products,
    servicos: services,
  };
}

export const prepararCriacaoOrcamento = defineTool({
  name: "preparar_criacao_orcamento",
  title: "Preparar orçamento no GestãoClick",
  description:
    "Valida cliente, situação, produtos, serviços, preços e total e gera uma prévia. Não cria o orçamento. Depois da confirmação explícita do usuário, use confirmar_criacao_orcamento.",
  inputSchema: {
    tipo: z.enum(["produto", "servico"]),
    cliente_id: z.string().trim().regex(/^\d+$/),
    situacao_id: z.string().trim().regex(/^\d+$/),
    loja_id: z.string().trim().regex(/^\d+$/).optional(),
    usuario_id: z.string().trim().regex(/^\d+$/).optional(),
    vendedor_id: z.string().trim().regex(/^\d+$/).optional(),
    data: z.string().date(),
    validade: z.string().trim().max(60).optional(),
    observacoes: z.string().trim().max(2000).optional(),
    produtos: z.array(itemSchema).max(100).default([]),
    servicos: z.array(itemSchema).max(100).default([]),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "preparar_criacao_orcamento",
        operationType: "prepare",
        sourceSystem: "gestaoclick",
        allowedRoles: COMMERCIAL_WRITE_ROLES,
        parameters: input,
        targetEntity: "orcamento",
      },
      async (actor, requestId) => {
        const produtos = input.produtos as GcItem[];
        const servicos = input.servicos as GcItem[];
        if (!produtos.length && !servicos.length) {
          throw new McpToolError("INVALID_INPUT", "Inclua ao menos um produto ou serviço.");
        }
        const previewResolved = await resolvePreview({
          clienteId: input.cliente_id,
          situacaoId: input.situacao_id,
          situationKind: "orcamento",
          produtos,
          servicos,
        });
        const amountCents = totalCents([...produtos, ...servicos]);
        const payload: Record<string, unknown> = {
          tipo: input.tipo,
          cliente_id: input.cliente_id,
          situacao_id: input.situacao_id,
          data: input.data,
          valor_total: centsToMoney(amountCents),
          valor_frete: "0.00",
          desconto_valor: "0.00",
          desconto_porcentagem: "0.00",
          condicao_pagamento: "a_vista",
          produtos: buildLines(produtos, "produto"),
          servicos: buildLines(servicos, "servico"),
          ...(input.loja_id ? { loja_id: input.loja_id } : {}),
          ...(input.usuario_id ? { usuario_id: input.usuario_id } : {}),
          ...(input.vendedor_id ? { vendedor_id: input.vendedor_id } : {}),
          ...(input.validade ? { validade: input.validade } : {}),
          ...(input.observacoes ? { observacoes: input.observacoes } : {}),
        };
        return prepareAction({
          actor,
          action: "criar_orcamento_gc",
          payload,
          requestId,
          preview: {
            tipo: input.tipo,
            ...previewResolved,
            data: input.data,
            validade: input.validade ?? null,
            loja_id: input.loja_id ?? "matriz/padrão da credencial",
            total: centsToMoney(amountCents),
            condicao_pagamento: "a_vista",
          },
        });
      },
    ),
});

export const confirmarCriacaoOrcamento = defineTool({
  name: "confirmar_criacao_orcamento",
  title: "Confirmar criação de orçamento",
  description:
    "Cria exatamente o orçamento previamente preparado. Só use após confirmação explícita do usuário na conversa.",
  inputSchema: {
    pending_action_id: z.string().uuid(),
    confirmation_token: z.string().length(64),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "confirmar_criacao_orcamento",
        operationType: "write",
        sourceSystem: "gestaoclick",
        allowedRoles: COMMERCIAL_WRITE_ROLES,
        parameters: { pending_action_id: input.pending_action_id },
        targetEntity: "orcamento",
      },
      async (actor) => {
        const claimed = await claimAction({
          actor,
          actionId: input.pending_action_id,
          confirmationToken: input.confirmation_token,
          expectedAction: "criar_orcamento_gc",
        });
        try {
          const payload = claimed.payload as JsonRecord;
          await resolvePreview({
            clienteId: String(payload.cliente_id),
            situacaoId: String(payload.situacao_id),
            situationKind: "orcamento",
            produtos: (payload.produtos ?? []).map((wrapper: {
              produto: { produto_id: unknown; quantidade: unknown; valor_venda: string | number };
            }) => ({
              id: String(wrapper.produto.produto_id),
              quantidade: Number(wrapper.produto.quantidade),
              valor_unitario: wrapper.produto.valor_venda,
            })),
            servicos: (payload.servicos ?? []).map((wrapper: {
              servico: { servico_id: unknown; quantidade: unknown; valor_venda: string | number };
            }) => ({
              id: String(wrapper.servico.servico_id),
              quantidade: Number(wrapper.servico.quantidade),
              valor_unitario: wrapper.servico.valor_venda,
            })),
          });
          const response = await gcRequest<unknown>("/orcamentos", "POST", payload);
          const created = gcData<JsonRecord>(response);
          if (!created?.id) {
            throw new McpToolError(
              "GC_UNAVAILABLE",
              "O GestãoClick respondeu sem o ID do orçamento. Não tente novamente automaticamente.",
            );
          }
          await completeAction(input.pending_action_id, {
            user_id: actor.id,
            tool_name: "criar_orcamento_gc",
            payload_hash: claimed.payloadHash,
            upstream_id: String(created.id),
            codigo: created.codigo ?? null,
          });
          return {
            created: true,
            orcamento_id: String(created.id),
            codigo: created.codigo ?? null,
            url: `https://app.gestaoclick.com/orcamentos/visualizar/${created.id}`,
            source: "gestaoclick_live",
          };
        } catch (error) {
          await failAction(input.pending_action_id, error);
          throw error;
        }
      },
    ),
});

export const prepararCriacaoOrdemServico = defineTool({
  name: "preparar_criacao_ordem_servico",
  title: "Preparar ordem de serviço no GestãoClick",
  description:
    "Valida os dados e gera a prévia de uma OS no GestãoClick. Não cria a OS. A tarefa Auvo deve ser preparada separadamente quando necessária.",
  inputSchema: {
    cliente_id: z.string().trim().regex(/^\d+$/),
    situacao_id: z.string().trim().regex(/^\d+$/),
    codigo: z.string().trim().max(40).optional(),
    loja_id: z.string().trim().regex(/^\d+$/).optional(),
    usuario_id: z.string().trim().regex(/^\d+$/).optional(),
    vendedor_id: z.string().trim().regex(/^\d+$/).optional(),
    tecnico_id: z.string().trim().regex(/^\d+$/).optional(),
    centro_custo_id: z.string().trim().regex(/^\d+$/).optional(),
    data: z.string().date(),
    observacoes: z.string().trim().max(2000).optional(),
    observacoes_interna: z.string().trim().max(2000).optional(),
    produtos: z.array(itemSchema).max(100).default([]),
    servicos: z.array(itemSchema).max(100).default([]),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "preparar_criacao_ordem_servico",
        operationType: "prepare",
        sourceSystem: "gestaoclick",
        allowedRoles: OS_WRITE_ROLES,
        parameters: input,
        targetEntity: "ordem_servico",
      },
      async (actor, requestId) => {
        const produtos = input.produtos as GcItem[];
        const servicos = input.servicos as GcItem[];
        if (!produtos.length && !servicos.length) {
          throw new McpToolError("INVALID_INPUT", "Inclua ao menos um produto ou serviço.");
        }
        const previewResolved = await resolvePreview({
          clienteId: input.cliente_id,
          situacaoId: input.situacao_id,
          situationKind: "os",
          produtos,
          servicos,
        });
        const amountCents = totalCents([...produtos, ...servicos]);
        const payload: Record<string, unknown> = {
          cliente_id: input.cliente_id,
          situacao_id: input.situacao_id,
          data: input.data,
          valor_total: centsToMoney(amountCents),
          valor_frete: "0.00",
          condicao_pagamento: "a_vista",
          produtos: buildLines(produtos, "produto"),
          servicos: buildLines(servicos, "servico"),
          ...(input.codigo ? { codigo: input.codigo } : {}),
          ...(input.loja_id ? { loja_id: input.loja_id } : {}),
          ...(input.usuario_id ? { usuario_id: input.usuario_id } : {}),
          ...(input.vendedor_id ? { vendedor_id: input.vendedor_id } : {}),
          ...(input.tecnico_id ? { tecnico_id: input.tecnico_id } : {}),
          ...(input.centro_custo_id ? { centro_custo_id: input.centro_custo_id } : {}),
          ...(input.observacoes ? { observacoes: input.observacoes } : {}),
          ...(input.observacoes_interna
            ? { observacoes_interna: input.observacoes_interna }
            : {}),
        };
        return prepareAction({
          actor,
          action: "criar_ordem_servico_gc",
          payload,
          requestId,
          preview: {
            ...previewResolved,
            codigo: input.codigo ?? "gerado pelo GestãoClick",
            data: input.data,
            loja_id: input.loja_id ?? "matriz/padrão da credencial",
            tecnico_id: input.tecnico_id ?? null,
            total: centsToMoney(amountCents),
            condicao_pagamento: "a_vista",
          },
        });
      },
    ),
});

export const confirmarCriacaoOrdemServico = defineTool({
  name: "confirmar_criacao_ordem_servico",
  title: "Confirmar criação de ordem de serviço",
  description:
    "Cria exatamente a OS previamente preparada no GestãoClick. Só use após confirmação explícita do usuário.",
  inputSchema: {
    pending_action_id: z.string().uuid(),
    confirmation_token: z.string().length(64),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "confirmar_criacao_ordem_servico",
        operationType: "write",
        sourceSystem: "gestaoclick",
        allowedRoles: OS_WRITE_ROLES,
        parameters: { pending_action_id: input.pending_action_id },
        targetEntity: "ordem_servico",
      },
      async (actor) => {
        const claimed = await claimAction({
          actor,
          actionId: input.pending_action_id,
          confirmationToken: input.confirmation_token,
          expectedAction: "criar_ordem_servico_gc",
        });
        try {
          const payload = claimed.payload as JsonRecord;
          await resolvePreview({
            clienteId: String(payload.cliente_id),
            situacaoId: String(payload.situacao_id),
            situationKind: "os",
            produtos: (payload.produtos ?? []).map((wrapper: {
              produto: { produto_id: unknown; quantidade: unknown; valor_venda: string | number };
            }) => ({
              id: String(wrapper.produto.produto_id),
              quantidade: Number(wrapper.produto.quantidade),
              valor_unitario: wrapper.produto.valor_venda,
            })),
            servicos: (payload.servicos ?? []).map((wrapper: {
              servico: { servico_id: unknown; quantidade: unknown; valor_venda: string | number };
            }) => ({
              id: String(wrapper.servico.servico_id),
              quantidade: Number(wrapper.servico.quantidade),
              valor_unitario: wrapper.servico.valor_venda,
            })),
          });
          const response = await gcRequest<unknown>(
            "/api/ordens_servicos",
            "POST",
            payload,
          );
          const created = gcData<JsonRecord>(response);
          if (!created?.id) {
            throw new McpToolError(
              "GC_UNAVAILABLE",
              "O GestãoClick respondeu sem o ID da OS. Não tente novamente automaticamente.",
            );
          }
          await completeAction(input.pending_action_id, {
            user_id: actor.id,
            tool_name: "criar_ordem_servico_gc",
            payload_hash: claimed.payloadHash,
            upstream_id: String(created.id),
            codigo: created.codigo ?? null,
          });
          return {
            created: true,
            ordem_servico_id: String(created.id),
            codigo: created.codigo ?? null,
            source: "gestaoclick_live",
          };
        } catch (error) {
          await failAction(input.pending_action_id, error);
          throw error;
        }
      },
    ),
});

export const gcWriteTools = [
  prepararCriacaoOrcamento,
  confirmarCriacaoOrcamento,
  prepararCriacaoOrdemServico,
  confirmarCriacaoOrdemServico,
];
