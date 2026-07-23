import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { errorResult, McpToolError, successResult } from "../shared/errors";
import { gcData, gcRequest, queryString } from "../shared/gc-client";
import {
  requestIdFrom,
  runAudited,
  type AppRole,
} from "../shared/supabase";

const READ_ROLES: readonly AppRole[] = [
  "admin",
  "ceo",
  "gerente_comercial",
  "gerente_financeiro",
  "vendedor",
  "user",
];

// A API GestãoClick não publica um schema uniforme para todos os recursos.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

function maskDocument(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length <= 5) return "***";
  return `${digits.slice(0, 2)}***${digits.slice(-3)}`;
}

function listFromGc(response: unknown): JsonRecord[] {
  const data = gcData<unknown>(response);
  return Array.isArray(data) ? data : [];
}

function handle<T extends object>(
  ctx: ToolContext,
  options: Parameters<typeof runAudited<T>>[1],
  operation: Parameters<typeof runAudited<T>>[2],
) {
  return runAudited(ctx, options, operation)
    .then(({ data, requestId }) => successResult({ ok: true, request_id: requestId, ...data }))
    .catch((error) => errorResult(error, requestIdFrom(error)));
}

export const buscarCliente = defineTool({
  name: "buscar_cliente",
  title: "Buscar cliente no GestãoClick",
  description:
    "Localiza clientes no GestãoClick por nome, CPF/CNPJ, e-mail ou telefone. Use antes de consultar ou criar registros. Se houver mais de um candidato, peça ao usuário para escolher.",
  inputSchema: {
    nome: z.string().trim().min(2).max(120).optional(),
    cpf_cnpj: z.string().trim().min(5).max(24).optional(),
    email: z.string().trim().max(160).optional(),
    telefone: z.string().trim().max(30).optional(),
    somente_ativos: z.boolean().default(true),
    limite: z.number().int().min(1).max(20).default(10),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "buscar_cliente",
        operationType: "read",
        sourceSystem: "gestaoclick",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "cliente",
      },
      async () => {
        if (!input.nome && !input.cpf_cnpj && !input.email && !input.telefone) {
          throw new McpToolError(
            "INVALID_INPUT",
            "Informe nome, CPF/CNPJ, e-mail ou telefone para buscar o cliente.",
          );
        }
        const response = await gcRequest<unknown>(
          `/clientes${queryString({
            nome: input.nome,
            cpf_cnpj: input.cpf_cnpj,
            email: input.email,
            telefone: input.telefone,
            situacao: input.somente_ativos ? 1 : undefined,
            limite: input.limite,
          })}`,
        );
        const rows = listFromGc(response).slice(0, input.limite).map((row) => ({
          id: String(row.id),
          nome: row.nome,
          razao_social: row.razao_social ?? null,
          documento_mascarado: maskDocument(row.cnpj ?? row.cpf),
          cidade: row.enderecos?.[0]?.endereco?.nome_cidade ?? null,
          estado: row.enderecos?.[0]?.endereco?.estado ?? null,
          ativo: String(row.ativo) !== "0",
        }));
        return {
          status: rows.length > 1 ? "needs_disambiguation" : rows.length ? "found" : "not_found",
          candidates: rows,
          count: rows.length,
        };
      },
    ),
});

export const detalharCliente = defineTool({
  name: "detalhar_cliente",
  title: "Detalhar cliente no GestãoClick",
  description:
    "Obtém o cadastro completo e atual de um cliente específico no GestãoClick pelo ID.",
  inputSchema: {
    cliente_id: z.string().trim().regex(/^\d+$/).max(30),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "detalhar_cliente",
        operationType: "read",
        sourceSystem: "gestaoclick",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "cliente",
      },
      async () => {
        const response = await gcRequest<unknown>(`/clientes/${input.cliente_id}`);
        const row = gcData<JsonRecord>(response);
        if (!row?.id) throw new McpToolError("NOT_FOUND", "Cliente não encontrado.");
        return { cliente: row, source: "gestaoclick_live" };
      },
    ),
});

export const buscarOrdensServico = defineTool({
  name: "buscar_ordens_servico",
  title: "Buscar ordens de serviço",
  description:
    "Consulta ordens de serviço diretamente no GestãoClick por cliente, código, situação ou período. Não altera registros.",
  inputSchema: {
    cliente_id: z.string().trim().regex(/^\d+$/).optional(),
    codigo: z.string().trim().max(40).optional(),
    situacao_id: z.string().trim().regex(/^\d+$/).optional(),
    data_inicio: z.string().date().optional(),
    data_fim: z.string().date().optional(),
    pagina: z.number().int().min(1).max(1000).default(1),
    limite: z.number().int().min(1).max(100).default(30),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "buscar_ordens_servico",
        operationType: "read",
        sourceSystem: "gestaoclick",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "ordem_servico",
      },
      async () => {
        const response = await gcRequest<unknown>(
          `/api/ordens_servicos${queryString({
            cliente_id: input.cliente_id,
            codigo: input.codigo,
            situacao_id: input.situacao_id,
            data_inicio: input.data_inicio,
            data_fim: input.data_fim,
            pagina: input.pagina,
            limite: input.limite,
          })}`,
        );
        const rows = listFromGc(response);
        return {
          rows,
          count: rows.length,
          pagina: input.pagina,
          source: "gestaoclick_live",
        };
      },
    ),
});

export const detalharOrdemServico = defineTool({
  name: "detalhar_ordem_servico",
  title: "Detalhar ordem de serviço",
  description:
    "Busca a versão atual e completa de uma ordem de serviço no GestãoClick pelo ID.",
  inputSchema: {
    ordem_servico_id: z.string().trim().regex(/^\d+$/).max(30),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "detalhar_ordem_servico",
        operationType: "read",
        sourceSystem: "gestaoclick",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "ordem_servico",
      },
      async () => {
        const response = await gcRequest<unknown>(
          `/api/ordens_servicos/${input.ordem_servico_id}`,
        );
        const row = gcData<JsonRecord>(response);
        if (!row?.id) throw new McpToolError("NOT_FOUND", "Ordem de serviço não encontrada.");
        return { ordem_servico: row, source: "gestaoclick_live" };
      },
    ),
});

export const buscarOrcamentos = defineTool({
  name: "buscar_orcamentos",
  title: "Buscar orçamentos",
  description:
    "Consulta orçamentos diretamente no GestãoClick por cliente, código, situação ou tipo.",
  inputSchema: {
    cliente_id: z.string().trim().regex(/^\d+$/).optional(),
    codigo: z.string().trim().max(40).optional(),
    situacao_id: z.string().trim().regex(/^\d+$/).optional(),
    tipo: z.enum(["produto", "servico"]).optional(),
    pagina: z.number().int().min(1).max(1000).default(1),
    limite: z.number().int().min(1).max(100).default(30),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "buscar_orcamentos",
        operationType: "read",
        sourceSystem: "gestaoclick",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "orcamento",
      },
      async () => {
        const response = await gcRequest<unknown>(
          `/api/orcamentos${queryString({
            cliente_id: input.cliente_id,
            codigo: input.codigo,
            situacao_id: input.situacao_id,
            tipo: input.tipo,
            pagina: input.pagina,
            limite: input.limite,
          })}`,
        );
        const rows = listFromGc(response);
        return { rows, count: rows.length, pagina: input.pagina, source: "gestaoclick_live" };
      },
    ),
});

export const detalharOrcamento = defineTool({
  name: "detalhar_orcamento",
  title: "Detalhar orçamento",
  description: "Obtém o orçamento completo e atual no GestãoClick pelo ID.",
  inputSchema: {
    orcamento_id: z.string().trim().regex(/^\d+$/).max(30),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "detalhar_orcamento",
        operationType: "read",
        sourceSystem: "gestaoclick",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "orcamento",
      },
      async () => {
        const response = await gcRequest<unknown>(`/api/orcamentos/${input.orcamento_id}`);
        const row = gcData<JsonRecord>(response);
        if (!row?.id) throw new McpToolError("NOT_FOUND", "Orçamento não encontrado.");
        return { orcamento: row, source: "gestaoclick_live" };
      },
    ),
});

export const buscarProdutoServico = defineTool({
  name: "buscar_produto_servico",
  title: "Buscar produto ou serviço",
  description:
    "Pesquisa o catálogo atual do GestãoClick. Use para resolver IDs, preço e disponibilidade antes de montar orçamento ou OS.",
  inputSchema: {
    termo: z.string().trim().min(2).max(120),
    tipo: z.enum(["produto", "servico", "ambos"]).default("ambos"),
    pagina: z.number().int().min(1).max(1000).default(1),
    limite: z.number().int().min(1).max(50).default(20),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "buscar_produto_servico",
        operationType: "read",
        sourceSystem: "gestaoclick",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "catalogo",
      },
      async () => {
        const calls: Promise<{ tipo: string; rows: JsonRecord[] }>[] = [];
        if (input.tipo !== "servico") {
          calls.push(
            gcRequest<unknown>(
              `/produtos${queryString({
                nome: input.termo,
                pagina: input.pagina,
                limite: input.limite,
              })}`,
            ).then(async (response) => {
              let rows = listFromGc(response);
              if (!rows.length) {
                const byCode = await gcRequest<unknown>(
                  `/produtos${queryString({
                    codigo_interno: input.termo,
                    pagina: input.pagina,
                    limite: input.limite,
                  })}`,
                );
                rows = listFromGc(byCode);
              }
              return { tipo: "produto", rows };
            }),
          );
        }
        if (input.tipo !== "produto") {
          calls.push(
            gcRequest<unknown>(
              `/servicos${queryString({
                nome: input.termo,
                pagina: input.pagina,
                limite: input.limite,
              })}`,
            ).then(async (response) => {
              let rows = listFromGc(response);
              if (!rows.length) {
                const byCode = await gcRequest<unknown>(
                  `/servicos${queryString({
                    codigo: input.termo,
                    pagina: input.pagina,
                    limite: input.limite,
                  })}`,
                );
                rows = listFromGc(byCode);
              }
              return { tipo: "servico", rows };
            }),
          );
        }
        const groups = await Promise.all(calls);
        const rows = groups.flatMap((group) =>
          group.rows.map((row) => ({ tipo: group.tipo, ...row })),
        );
        return { rows, count: rows.length, source: "gestaoclick_live" };
      },
    ),
});

export const consultarEstoque = defineTool({
  name: "consultar_estoque",
  title: "Consultar estoque",
  description:
    "Consulta no GestãoClick o estoque atual de um produto específico pelo ID.",
  inputSchema: {
    produto_id: z.string().trim().regex(/^\d+$/).max(30),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "consultar_estoque",
        operationType: "read",
        sourceSystem: "gestaoclick",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "produto",
      },
      async () => {
        const response = await gcRequest<unknown>(`/api/produtos/${input.produto_id}`);
        const row = gcData<JsonRecord>(response);
        if (!row?.id) throw new McpToolError("NOT_FOUND", "Produto não encontrado.");
        return {
          produto: {
            id: String(row.id),
            nome: row.nome,
            codigo_interno: row.codigo_interno ?? null,
            estoque: row.estoque ?? null,
            movimenta_estoque: row.movimenta_estoque ?? null,
            valor_custo: row.valor_custo ?? null,
            valor_venda: row.valor_venda ?? null,
            valores: row.valores ?? [],
            ativo: row.ativo,
          },
          source: "gestaoclick_live",
        };
      },
    ),
});

function configTool(
  name: string,
  title: string,
  description: string,
  path: string,
  entity: string,
) {
  return defineTool({
    name,
    title,
    description,
    inputSchema: {
      pagina: z.number().int().min(1).max(100).default(1),
      limite: z.number().int().min(1).max(100).default(100),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (input, ctx) =>
      handle(
        ctx,
        {
          toolName: name,
          operationType: "read",
          sourceSystem: "gestaoclick",
          allowedRoles: READ_ROLES,
          parameters: input,
          targetEntity: entity,
        },
        async () => {
          const response = await gcRequest<unknown>(
            `${path}${queryString({ pagina: input.pagina, limite: input.limite })}`,
          );
          const rows = listFromGc(response);
          return { rows, count: rows.length, source: "gestaoclick_live" };
        },
      ),
  });
}

export const listarSituacoesOrcamento = configTool(
  "listar_situacoes_orcamento",
  "Listar situações de orçamento",
  "Lista os IDs e nomes válidos de situações de orçamento no GestãoClick.",
  "/api/situacoes_orcamentos",
  "situacao_orcamento",
);

export const listarSituacoesOs = configTool(
  "listar_situacoes_os",
  "Listar situações de OS",
  "Lista os IDs e nomes válidos de situações de ordem de serviço no GestãoClick.",
  "/api/situacoes_ordens_servicos",
  "situacao_os",
);

export const listarLojasGc = configTool(
  "listar_lojas_gc",
  "Listar lojas do GestãoClick",
  "Lista lojas válidas para atribuir orçamentos e ordens de serviço.",
  "/api/lojas",
  "loja",
);

export const gcReadTools = [
  buscarCliente,
  detalharCliente,
  buscarOrdensServico,
  detalharOrdemServico,
  buscarOrcamentos,
  detalharOrcamento,
  buscarProdutoServico,
  consultarEstoque,
  listarSituacoesOrcamento,
  listarSituacoesOs,
  listarLojasGc,
];
