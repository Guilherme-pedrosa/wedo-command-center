import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { auvoListPath, auvoRequest, auvoResult } from "../shared/auvo-client";
import { errorResult, McpToolError, successResult } from "../shared/errors";
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

const READ_ROLES: readonly AppRole[] = [
  "admin",
  "ceo",
  "gerente_comercial",
  "gerente_financeiro",
  "vendedor",
  "user",
];
const WRITE_ROLES: readonly AppRole[] = ["admin", "ceo"];
// Respostas Auvo variam por endpoint e versão; o acesso dinâmico fica isolado neste tipo de borda.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

function resultList(response: unknown): JsonRecord[] {
  const result = auvoResult<unknown>(response);
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && "entityList" in result) {
    const rows = (result as { entityList?: unknown }).entityList;
    return Array.isArray(rows) ? rows : [];
  }
  return [];
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

export const buscarClienteAuvo = defineTool({
  name: "buscar_cliente_auvo",
  title: "Buscar cliente no Auvo",
  description:
    "Localiza o cadastro operacional de um cliente no Auvo. Use o externalId para relacionar com outro sistema quando disponível.",
  inputSchema: {
    nome: z.string().trim().min(2).max(120).optional(),
    external_id: z.string().trim().max(80).optional(),
    somente_ativos: z.boolean().default(true),
    pagina: z.number().int().min(1).max(1000).default(1),
    limite: z.number().int().min(1).max(100).default(20),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "buscar_cliente_auvo",
        operationType: "read",
        sourceSystem: "auvo",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "cliente_auvo",
      },
      async () => {
        if (!input.nome && !input.external_id) {
          throw new McpToolError("INVALID_INPUT", "Informe nome ou external_id.");
        }
        const response = await auvoRequest<unknown>(
          auvoListPath(
            "customers",
            {
              description: input.nome,
              externalId: input.external_id,
              active: input.somente_ativos ? true : undefined,
            },
            input.pagina,
            input.limite,
          ),
        );
        const rows = resultList(response).map((row) => ({
          id: row.id,
          external_id: row.externalId ?? null,
          nome: row.description,
          cidade_endereco: row.address ?? null,
          ativo: row.active,
        }));
        return {
          status: rows.length > 1 ? "needs_disambiguation" : rows.length ? "found" : "not_found",
          candidates: rows,
          count: rows.length,
        };
      },
    ),
});

export const buscarEquipamentos = defineTool({
  name: "buscar_equipamentos",
  title: "Buscar equipamentos no Auvo",
  description:
    "Localiza equipamentos no Auvo por cliente, nome, identificador ou referência externa.",
  inputSchema: {
    cliente_auvo_id: z.number().int().positive().optional(),
    nome: z.string().trim().max(120).optional(),
    identificador: z.string().trim().max(120).optional(),
    external_id: z.string().trim().max(120).optional(),
    somente_ativos: z.boolean().default(true),
    pagina: z.number().int().min(1).max(1000).default(1),
    limite: z.number().int().min(1).max(100).default(30),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "buscar_equipamentos",
        operationType: "read",
        sourceSystem: "auvo",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "equipamento",
      },
      async () => {
        if (
          !input.cliente_auvo_id &&
          !input.nome &&
          !input.identificador &&
          !input.external_id
        ) {
          throw new McpToolError(
            "INVALID_INPUT",
            "Informe cliente, nome, identificador ou external_id do equipamento.",
          );
        }
        const response = await auvoRequest<unknown>(
          auvoListPath(
            "equipments",
            {
              associatedCustomerId: input.cliente_auvo_id,
              name: input.nome,
              identifier: input.identificador,
              externalId: input.external_id,
              active: input.somente_ativos ? true : undefined,
            },
            input.pagina,
            input.limite,
          ),
        );
        const rows = resultList(response).map((row) => ({
          id: row.id,
          external_id: row.externalId ?? null,
          cliente_auvo_id: row.associatedCustomerId ?? null,
          nome: row.name,
          identificador: row.identifier ?? null,
          descricao: row.description ?? null,
          ativo: row.active,
        }));
        return {
          status: rows.length > 1 ? "needs_disambiguation" : rows.length ? "found" : "not_found",
          candidates: rows,
          count: rows.length,
        };
      },
    ),
});

export const detalharEquipamento = defineTool({
  name: "detalhar_equipamento",
  title: "Detalhar equipamento no Auvo",
  description: "Obtém o cadastro completo e atual de um equipamento no Auvo.",
  inputSchema: { equipamento_auvo_id: z.number().int().positive() },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "detalhar_equipamento",
        operationType: "read",
        sourceSystem: "auvo",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "equipamento",
      },
      async () => {
        const response = await auvoRequest<unknown>(`/equipments/${input.equipamento_auvo_id}`);
        return { equipamento: auvoResult<JsonRecord>(response), source: "auvo_live" };
      },
    ),
});

export const consultarTarefaAuvo = defineTool({
  name: "consultar_tarefa_auvo",
  title: "Consultar tarefa no Auvo",
  description: "Consulta uma tarefa específica no Auvo pelo taskID.",
  inputSchema: { tarefa_auvo_id: z.number().int().positive() },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "consultar_tarefa_auvo",
        operationType: "read",
        sourceSystem: "auvo",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "tarefa_auvo",
      },
      async () => {
        const response = await auvoRequest<unknown>(`/tasks/${input.tarefa_auvo_id}`);
        return { tarefa: auvoResult<JsonRecord>(response), source: "auvo_live" };
      },
    ),
});

export const listarTecnicosAuvo = defineTool({
  name: "listar_tecnicos_auvo",
  title: "Listar técnicos do Auvo",
  description:
    "Lista usuários/técnicos do Auvo para selecionar o responsável correto por uma tarefa.",
  inputSchema: {
    nome: z.string().trim().max(120).optional(),
    pagina: z.number().int().min(1).max(100).default(1),
    limite: z.number().int().min(1).max(100).default(50),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "listar_tecnicos_auvo",
        operationType: "read",
        sourceSystem: "auvo",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "usuario_auvo",
      },
      async () => {
        const response = await auvoRequest<unknown>(
          auvoListPath("users", { name: input.nome }, input.pagina, input.limite),
        );
        const rows = resultList(response).map((row) => ({
          id: row.userId,
          external_id: row.externalId ?? null,
          nome: row.name,
          cargo: row.jobPosition ?? null,
          tipo: row.userType?.description ?? null,
          indisponivel_para_tarefas: row.unavailableForTasks ?? false,
          horario_inicio: row.startWorkHour ?? null,
          horario_fim: row.endWorkHour ?? null,
        }));
        return { rows, count: rows.length, source: "auvo_live" };
      },
    ),
});

export const listarTiposTarefaAuvo = defineTool({
  name: "listar_tipos_tarefa_auvo",
  title: "Listar tipos de tarefa do Auvo",
  description: "Lista tipos de tarefa válidos no Auvo para criar um agendamento.",
  inputSchema: {
    descricao: z.string().trim().max(120).optional(),
    pagina: z.number().int().min(1).max(100).default(1),
    limite: z.number().int().min(1).max(100).default(50),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "listar_tipos_tarefa_auvo",
        operationType: "read",
        sourceSystem: "auvo",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "tipo_tarefa_auvo",
      },
      async () => {
        const response = await auvoRequest<unknown>(
          auvoListPath("taskTypes", { description: input.descricao }, input.pagina, input.limite),
        );
        const rows = resultList(response).map((row) => ({
          id: row.id,
          descricao: row.description,
          ativo: row.active,
          duracao_padrao: row.standartTime ?? null,
          questionario_padrao_id: row.standartQuestionnaireId ?? null,
        }));
        return { rows, count: rows.length, source: "auvo_live" };
      },
    ),
});

function addMinutes(dateISO: string, startTime: string, minutes: number): string {
  const [year, month, day] = dateISO.split("-").map(Number);
  const [hour, minute] = startTime.split(":").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes, 0));
  const pad = (item: number) => String(item).padStart(2, "0");
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:00`;
}

export const prepararCriacaoTarefaAuvo = defineTool({
  name: "preparar_criacao_tarefa_auvo",
  title: "Preparar tarefa no Auvo",
  description:
    "Valida equipamento, cliente, técnico, tipo, data e horário e gera uma prévia. Não cria a tarefa. Depois de mostrar a prévia e obter confirmação explícita do usuário, use confirmar_criacao_tarefa_auvo.",
  inputSchema: {
    equipamento_auvo_id: z.number().int().positive(),
    tecnico_auvo_id: z.number().int().positive(),
    tipo_tarefa_auvo_id: z.number().int().positive(),
    data: z.string().date(),
    hora_inicio: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    duracao_minutos: z.number().int().min(15).max(1440).default(120),
    orientacao: z.string().trim().min(3).max(500),
    prioridade: z.number().int().min(1).max(3).default(1),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "preparar_criacao_tarefa_auvo",
        operationType: "prepare",
        sourceSystem: "auvo",
        allowedRoles: WRITE_ROLES,
        parameters: input,
        targetEntity: "tarefa_auvo",
      },
      async (actor, requestId) => {
        const [equipmentResponse, technicianResponse, typeResponse] = await Promise.all([
          auvoRequest<unknown>(`/equipments/${input.equipamento_auvo_id}`),
          auvoRequest<unknown>(`/users/${input.tecnico_auvo_id}`),
          auvoRequest<unknown>(`/taskTypes/${input.tipo_tarefa_auvo_id}`),
        ]);
        const equipment = auvoResult<JsonRecord>(equipmentResponse);
        const technician = auvoResult<JsonRecord>(technicianResponse);
        const taskType = auvoResult<JsonRecord>(typeResponse);
        const customerId = Number(
          equipment?.associatedCustomerId ?? equipment?.customerId ?? equipment?.idCustomer ?? 0,
        );
        if (!customerId) {
          throw new McpToolError(
            "INVALID_INPUT",
            "O equipamento não está vinculado a um cliente no Auvo.",
          );
        }
        const customerResponse = await auvoRequest<unknown>(`/customers/${customerId}`);
        const customer = auvoResult<JsonRecord>(customerResponse);
        const taskDate = `${input.data}T${input.hora_inicio}:00`;
        const taskEndDate = addMinutes(input.data, input.hora_inicio, input.duracao_minutos);
        const payload = {
          idUserFrom: input.tecnico_auvo_id,
          idUserTo: input.tecnico_auvo_id,
          customerId,
          taskType: input.tipo_tarefa_auvo_id,
          taskDate,
          taskEndDate,
          priority: input.prioridade,
          orientation: input.orientacao,
          equipmentsId: [input.equipamento_auvo_id],
          address: customer?.address || equipment?.address || "Endereço não informado",
          latitude: Number(customer?.latitude ?? equipment?.latitude ?? 0),
          longitude: Number(customer?.longitude ?? equipment?.longitude ?? 0),
          sendSatisfactionSurvey: false,
        };
        return prepareAction({
          actor,
          action: "criar_tarefa_auvo",
          payload,
          requestId,
          preview: {
            cliente: customer?.description ?? customerId,
            equipamento: equipment?.name ?? input.equipamento_auvo_id,
            tecnico: technician?.name ?? input.tecnico_auvo_id,
            tipo_tarefa: taskType?.description ?? input.tipo_tarefa_auvo_id,
            inicio: taskDate,
            fim: taskEndDate,
            prioridade: input.prioridade,
            orientacao: input.orientacao,
          },
        });
      },
    ),
});

export const confirmarCriacaoTarefaAuvo = defineTool({
  name: "confirmar_criacao_tarefa_auvo",
  title: "Confirmar criação de tarefa no Auvo",
  description:
    "Cria exatamente a tarefa previamente preparada. Só use depois de o usuário confirmar explicitamente a prévia na conversa.",
  inputSchema: {
    pending_action_id: z.string().uuid(),
    confirmation_token: z.string().length(64),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "confirmar_criacao_tarefa_auvo",
        operationType: "write",
        sourceSystem: "auvo",
        allowedRoles: WRITE_ROLES,
        parameters: { pending_action_id: input.pending_action_id },
        targetEntity: "tarefa_auvo",
      },
      async (actor) => {
        const claimed = await claimAction({
          actor,
          actionId: input.pending_action_id,
          confirmationToken: input.confirmation_token,
          expectedAction: "criar_tarefa_auvo",
        });
        try {
          const response = await auvoRequest<unknown>("/tasks", "PUT", claimed.payload);
          const result = auvoResult<JsonRecord>(response);
          const taskId =
            result?.taskID ??
            result?.taskId ??
            result?.id ??
            result?.entity?.taskID ??
            result?.entity?.id ??
            null;
          if (!taskId) {
            throw new McpToolError(
              "AUVO_UNAVAILABLE",
              "O Auvo respondeu sem o ID da tarefa. Não tente novamente automaticamente.",
            );
          }
          await completeAction(input.pending_action_id, {
            user_id: actor.id,
            tool_name: "criar_tarefa_auvo",
            payload_hash: claimed.payloadHash,
            upstream_id: String(taskId),
            task_id: String(taskId),
          });
          return {
            created: true,
            tarefa_auvo_id: String(taskId),
            source: "auvo_live",
          };
        } catch (error) {
          await failAction(input.pending_action_id, error);
          throw error;
        }
      },
    ),
});

export const auvoTools = [
  buscarClienteAuvo,
  buscarEquipamentos,
  detalharEquipamento,
  consultarTarefaAuvo,
  listarTecnicosAuvo,
  listarTiposTarefaAuvo,
  prepararCriacaoTarefaAuvo,
  confirmarCriacaoTarefaAuvo,
];
