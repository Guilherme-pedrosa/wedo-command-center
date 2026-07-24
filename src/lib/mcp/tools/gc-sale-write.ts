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

const SALES_WRITE_ROLES: readonly AppRole[] = [
  "admin",
  "ceo",
  "gerente_comercial",
  "vendedor",
];

// A API GestãoClick devolve envelopes legados heterogêneos; o tipo dinâmico fica na borda.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;
type SaleItem = {
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

function buildLines(items: SaleItem[], kind: "produto" | "servico") {
  return items.map((item) => {
    const unitCents = moneyToCents(item.valor_unitario);
    const total = Math.round(item.quantidade * unitCents);
    return {
      [kind]: {
        [`${kind}_id`]: item.id,
        quantidade: String(item.quantidade),
        valor_venda: centsToMoney(unitCents),
        valor_total: centsToMoney(total),
        detalhes: item.detalhes ?? "",
        tipo_desconto: "R$",
        desconto_valor: "0.00",
        desconto_porcentagem: "0.00",
      },
    };
  });
}

function itemsTotalCents(items: SaleItem[]): number {
  return items.reduce(
    (sum, item) => sum + Math.round(item.quantidade * moneyToCents(item.valor_unitario)),
    0,
  );
}

async function resolveSalePreview(options: {
  clienteId: string;
  situacaoId: string;
  tipo: "produto" | "servico";
  produtos: SaleItem[];
  servicos: SaleItem[];
}) {
  const client = gcData<JsonRecord>(
    await gcRequest<unknown>(`/clientes/${options.clienteId}`),
  );
  if (!client?.id) throw new McpToolError("NOT_FOUND", "Cliente não encontrado no GestãoClick.");

  const situationsData = gcData<unknown>(
    await gcRequest<unknown>("/api/situacoes_vendas?limite=100"),
  );
  const situations = Array.isArray(situationsData) ? situationsData : [];
  const situation = situations.find(
    (row) =>
      row !== null &&
      typeof row === "object" &&
      String((row as { id?: unknown }).id) === options.situacaoId,
  ) as { nome?: unknown; descricao?: unknown } | undefined;
  if (!situation) {
    throw new McpToolError(
      "INVALID_INPUT",
      `Situação ${options.situacaoId} não é válida para venda.`,
    );
  }

  if (!options.produtos.length && !options.servicos.length) {
    throw new McpToolError("INVALID_INPUT", "Inclua ao menos um produto ou serviço.");
  }
  if (options.tipo === "produto" && !options.produtos.length) {
    throw new McpToolError(
      "INVALID_INPUT",
      "Venda do tipo produto precisa conter ao menos um produto.",
    );
  }
  if (options.tipo === "servico" && !options.servicos.length) {
    throw new McpToolError(
      "INVALID_INPUT",
      "Venda do tipo serviço precisa conter ao menos um serviço.",
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
      nome: situation.nome ?? situation.descricao ?? "ID informado",
    },
    produtos: products,
    servicos: services,
  };
}

export const prepararCriacaoVenda = defineTool({
  name: "preparar_criacao_venda",
  title: "Preparar venda no GestãoClick",
  description:
    "Prepara venda de produto, venda de serviço ou venda mista no GestãoClick. Valida cliente, situação, itens, preços e pagamento, mas não grava. Depois da confirmação explícita, use confirmar_criacao_venda.",
  inputSchema: {
    tipo: z.enum(["produto", "servico"]),
    cliente_id: z.string().trim().regex(/^\d+$/),
    situacao_id: z.string().trim().regex(/^\d+$/),
    codigo: z.string().trim().max(40).optional(),
    data: z.string().date(),
    previsao_entrega: z.string().date().optional(),
    loja_id: z.string().trim().regex(/^\d+$/).optional(),
    vendedor_id: z.string().trim().regex(/^\d+$/).optional(),
    centro_custo_id: z.string().trim().regex(/^\d+$/).optional(),
    transportadora_id: z.string().trim().regex(/^\d+$/).optional(),
    observacoes: z.string().trim().max(2000).optional(),
    observacoes_interna: z.string().trim().max(2000).optional(),
    valor_frete: z.union([z.string().trim().min(1).max(30), z.number().nonnegative()]).default("0"),
    condicao_pagamento: z.enum(["a_vista", "parcelado"]).default("a_vista"),
    forma_pagamento_id: z.string().trim().regex(/^\d+$/).optional(),
    numero_parcelas: z.number().int().min(1).max(120).optional(),
    intervalo_dias: z.number().int().min(0).max(3650).optional(),
    data_primeira_parcela: z.string().date().optional(),
    plano_contas_id: z.string().trim().regex(/^\d+$/).optional(),
    produtos: z.array(itemSchema).max(100).default([]),
    servicos: z.array(itemSchema).max(100).default([]),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "preparar_criacao_venda",
        operationType: "prepare",
        sourceSystem: "gestaoclick",
        allowedRoles: SALES_WRITE_ROLES,
        parameters: input,
        targetEntity: "venda",
      },
      async (actor, requestId) => {
        const produtos = input.produtos as SaleItem[];
        const servicos = input.servicos as SaleItem[];
        const previewResolved = await resolveSalePreview({
          clienteId: input.cliente_id,
          situacaoId: input.situacao_id,
          tipo: input.tipo,
          produtos,
          servicos,
        });

        if (input.condicao_pagamento === "parcelado" && !input.forma_pagamento_id) {
          throw new McpToolError(
            "INVALID_INPUT",
            "Venda parcelada exige forma_pagamento_id.",
          );
        }
        if (input.condicao_pagamento === "parcelado" && !input.numero_parcelas) {
          throw new McpToolError(
            "INVALID_INPUT",
            "Venda parcelada exige numero_parcelas.",
          );
        }

        const freightCents = moneyToCents(input.valor_frete);
        const itemsCents = itemsTotalCents([...produtos, ...servicos]);
        const amountCents = itemsCents + freightCents;
        const payload: Record<string, unknown> = {
          tipo: input.tipo,
          cliente_id: input.cliente_id,
          situacao_id: input.situacao_id,
          data: input.data,
          valor_total: centsToMoney(amountCents),
          valor_frete: centsToMoney(freightCents),
          condicao_pagamento: input.condicao_pagamento,
          produtos: buildLines(produtos, "produto"),
          servicos: buildLines(servicos, "servico"),
          ...(input.codigo ? { codigo: input.codigo } : {}),
          ...(input.previsao_entrega ? { previsao_entrega: input.previsao_entrega } : {}),
          ...(input.loja_id ? { loja_id: input.loja_id } : {}),
          ...(input.vendedor_id ? { vendedor_id: input.vendedor_id } : {}),
          ...(input.centro_custo_id ? { centro_custo_id: input.centro_custo_id } : {}),
          ...(input.transportadora_id
            ? { transportadora_id: input.transportadora_id }
            : {}),
          ...(input.observacoes ? { observacoes: input.observacoes } : {}),
          ...(input.observacoes_interna
            ? { observacoes_interna: input.observacoes_interna }
            : {}),
          ...(input.forma_pagamento_id
            ? {
                forma_pagamento_id: input.forma_pagamento_id,
                numero_parcelas: input.numero_parcelas ?? 1,
                ...(input.intervalo_dias !== undefined
                  ? { intervalo_dias: input.intervalo_dias }
                  : {}),
                ...(input.data_primeira_parcela
                  ? { data_primeira_parcela: input.data_primeira_parcela }
                  : {}),
                ...(input.plano_contas_id
                  ? { plano_contas_id: input.plano_contas_id }
                  : {}),
              }
            : {}),
        };

        return prepareAction({
          actor,
          action: "criar_venda_gc",
          payload,
          requestId,
          preview: {
            tipo: input.tipo,
            ...previewResolved,
            codigo: input.codigo ?? "gerado pelo GestãoClick",
            data: input.data,
            previsao_entrega: input.previsao_entrega ?? null,
            loja_id: input.loja_id ?? "matriz/padrão da credencial",
            subtotal: centsToMoney(itemsCents),
            frete: centsToMoney(freightCents),
            total: centsToMoney(amountCents),
            condicao_pagamento: input.condicao_pagamento,
            forma_pagamento_id: input.forma_pagamento_id ?? null,
            numero_parcelas:
              input.forma_pagamento_id ? input.numero_parcelas ?? 1 : null,
          },
        });
      },
    ),
});

export const confirmarCriacaoVenda = defineTool({
  name: "confirmar_criacao_venda",
  title: "Confirmar criação de venda",
  description:
    "Cria exatamente a venda previamente preparada no GestãoClick. Só use após confirmação explícita do usuário.",
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
        toolName: "confirmar_criacao_venda",
        operationType: "write",
        sourceSystem: "gestaoclick",
        allowedRoles: SALES_WRITE_ROLES,
        parameters: { pending_action_id: input.pending_action_id },
        targetEntity: "venda",
      },
      async (actor) => {
        const claimed = await claimAction({
          actor,
          actionId: input.pending_action_id,
          confirmationToken: input.confirmation_token,
          expectedAction: "criar_venda_gc",
        });
        try {
          const payload = claimed.payload as JsonRecord;
          await resolveSalePreview({
            clienteId: String(payload.cliente_id),
            situacaoId: String(payload.situacao_id),
            tipo: String(payload.tipo) as "produto" | "servico",
            produtos: (payload.produtos ?? []).map((wrapper: {
              produto: {
                produto_id: unknown;
                quantidade: unknown;
                valor_venda: string | number;
                detalhes?: unknown;
              };
            }) => ({
              id: String(wrapper.produto.produto_id),
              quantidade: Number(wrapper.produto.quantidade),
              valor_unitario: wrapper.produto.valor_venda,
              detalhes: String(wrapper.produto.detalhes ?? ""),
            })),
            servicos: (payload.servicos ?? []).map((wrapper: {
              servico: {
                servico_id: unknown;
                quantidade: unknown;
                valor_venda: string | number;
                detalhes?: unknown;
              };
            }) => ({
              id: String(wrapper.servico.servico_id),
              quantidade: Number(wrapper.servico.quantidade),
              valor_unitario: wrapper.servico.valor_venda,
              detalhes: String(wrapper.servico.detalhes ?? ""),
            })),
          });

          const response = await gcRequest<unknown>("/api/vendas", "POST", payload);
          const created = gcData<JsonRecord>(response);
          if (!created?.id) {
            throw new McpToolError(
              "GC_UNAVAILABLE",
              "O GestãoClick respondeu sem o ID da venda. Não tente novamente automaticamente.",
            );
          }
          await completeAction(input.pending_action_id, {
            user_id: actor.id,
            tool_name: "criar_venda_gc",
            payload_hash: claimed.payloadHash,
            upstream_id: String(created.id),
            codigo: created.codigo ?? null,
          });
          return {
            created: true,
            venda_id: String(created.id),
            codigo: created.codigo ?? null,
            tipo: created.tipo ?? payload.tipo,
            source: "gestaoclick_live",
          };
        } catch (error) {
          await failAction(input.pending_action_id, error);
          throw error;
        }
      },
    ),
});

export const gcSaleWriteTools = [
  prepararCriacaoVenda,
  confirmarCriacaoVenda,
];
