import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { auvoListPath, auvoRequest, auvoResult } from "../shared/auvo-client";
import { errorResult, McpToolError } from "../shared/errors";
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

function resultTotal(response: unknown): number | null {
  const result = auvoResult<unknown>(response);
  if (!result || typeof result !== "object") return null;
  const total = (result as JsonRecord).pagedSearchReturnData?.totalItems;
  const numeric = Number(total);
  return Number.isFinite(numeric) ? numeric : null;
}

function arrayOfRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object")
    : [];
}

function numericId(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function equipmentIdsFrom(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) =>
          numericId(
            item && typeof item === "object"
              ? (item as JsonRecord).id ??
                  (item as JsonRecord).equipmentId ??
                  (item as JsonRecord).equipmentCode
              : item,
          ),
        )
        .filter((item): item is number => item !== null),
    ),
  ];
}

function validHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizedExtension(value: unknown, url: string | null): string | null {
  const direct = typeof value === "string" ? value.trim().replace(/^\./, "").toLowerCase() : "";
  if (direct) return direct;
  if (!url) return null;
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]{2,8})$/i);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "heic", "heif"]);
const EMBEDDABLE_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const MAX_EMBEDDED_IMAGES = 10;
const MAX_EMBEDDED_IMAGE_BYTES = 2_000_000;

type AuvoResourceLinkContent = {
  type: "resource_link";
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
  annotations: {
    audience: ["user", "assistant"];
    priority: number;
  };
};

type AuvoImageContent = {
  type: "image";
  data: string;
  mimeType: string;
  annotations: {
    audience: ["user", "assistant"];
    priority: number;
  };
};

function trustedAuvoResourceUrl(value: unknown): string | null {
  const url = validHttpUrl(value);
  if (!url) return null;
  const hostname = new URL(url).hostname.toLowerCase();
  if (
    hostname === "auvo-producao.s3.amazonaws.com" ||
    hostname === "arquivos.auvo.com.br" ||
    hostname === "app.auvo.com.br" ||
    hostname.endsWith(".auvo.com.br")
  ) {
    return url;
  }
  return null;
}

function mimeTypeFromUrl(url: string): string | undefined {
  const extension = normalizedExtension(undefined, url);
  return {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    heic: "image/heic",
    heif: "image/heif",
  }[extension ?? ""];
}

function resourceName(path: string[], index: number, url: string): string {
  const joined = path.join(".").toLowerCase();
  if (mimeTypeFromUrl(url)) {
    if (joined.includes("assinatura")) return `Assinatura Auvo ${index + 1}`;
    return `Foto Auvo ${index + 1}`;
  }
  if (joined.includes("pesquisa_satisfacao") || joined.includes("survey")) {
    return "Pesquisa de satisfação Auvo";
  }
  if (joined.includes("relatorio_os_detalhado")) return "Relatório detalhado da OS Auvo";
  if (joined.includes("relatorio_os")) return "Relatório da OS Auvo";
  if (joined.includes("tarefa_relatorio") || joined.includes("taskurl")) {
    return "Relatório da tarefa Auvo";
  }
  return `Link Auvo ${index + 1}`;
}

function collectTrustedAuvoUrls(
  value: unknown,
  path: string[] = [],
  collected: Array<{ url: string; path: string[] }> = [],
): Array<{ url: string; path: string[] }> {
  if (typeof value === "string") {
    const url = trustedAuvoResourceUrl(value);
    if (url) collected.push({ url, path });
    return collected;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectTrustedAuvoUrls(item, [...path, String(index)], collected),
    );
    return collected;
  }
  if (value && typeof value === "object") {
    Object.entries(value as JsonRecord).forEach(([key, item]) =>
      collectTrustedAuvoUrls(item, [...path, key], collected),
    );
  }
  return collected;
}

export function buildAuvoResourceLinks(data: unknown): AuvoResourceLinkContent[] {
  const unique = new Map<string, string[]>();
  for (const item of collectTrustedAuvoUrls(data)) {
    if (!unique.has(item.url)) unique.set(item.url, item.path);
  }
  return [...unique.entries()].map(([url, path], index) => ({
    type: "resource_link",
    uri: url,
    name: resourceName(path, index, url),
    description: "Recurso retornado diretamente pela API do Auvo.",
    ...(mimeTypeFromUrl(url) ? { mimeType: mimeTypeFromUrl(url) } : {}),
    annotations: {
      audience: ["user", "assistant"],
      priority: 0.9,
    },
  }));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function embedAuvoImage(resource: AuvoResourceLinkContent): Promise<AuvoImageContent | null> {
  const extension = normalizedExtension(undefined, resource.uri);
  if (!extension || !EMBEDDABLE_IMAGE_EXTENSIONS.has(extension)) return null;
  try {
    const response = await fetch(resource.uri, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_EMBEDDED_IMAGE_BYTES) {
      return null;
    }
    const rawMimeType = response.headers.get("content-type")?.split(";")[0]?.trim();
    const mimeType = rawMimeType === "image/jpg" ? "image/jpeg" : rawMimeType;
    if (!mimeType?.startsWith("image/")) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_EMBEDDED_IMAGE_BYTES) return null;
    return {
      type: "image",
      data: bytesToBase64(bytes),
      mimeType,
      annotations: {
        audience: ["user", "assistant"],
        priority: 0.9,
      },
    };
  } catch {
    return null;
  }
}

async function auvoSuccessResult(data: Record<string, unknown>) {
  const resources = buildAuvoResourceLinks(data);
  const images = (
    await Promise.all(
      resources
        .filter((resource) => resource.mimeType?.startsWith("image/"))
        .slice(0, MAX_EMBEDDED_IMAGES)
        .map(embedAuvoImage),
    )
  ).filter((image): image is AuvoImageContent => image !== null);
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data) },
      ...resources,
      ...images,
    ],
    structuredContent: data,
  };
}

function normalizeAttachments(task: JsonRecord) {
  return arrayOfRecords(task.attachments)
    .map((attachment) => {
      const url = validHttpUrl(
        attachment.url ?? attachment.uri ?? attachment.href ?? attachment.attachmentUrl,
      );
      if (!url) return null;
      const extension = normalizedExtension(attachment.extension, url);
      return {
        id: attachment.id ?? null,
        url,
        tipo: extension && IMAGE_EXTENSIONS.has(extension) ? "foto" : "arquivo",
        extensao: extension,
        subtitulo: attachment.subtitle ?? null,
        descricao: attachment.description ?? null,
        tipo_auvo: attachment.attachmentType ?? null,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

const TASK_STATUS: Record<number, string> = {
  1: "aberta",
  2: "em_deslocamento",
  3: "check_in",
  4: "check_out",
  5: "finalizada",
  6: "pausada",
};

type ProjectTaskContext = {
  tarefa_url?: unknown;
  relatorio_os_url?: unknown;
  relatorio_os_detalhado_url?: unknown;
  ordem_servico_auvo_id?: unknown;
  ordem_servico_auvo_codigo?: unknown;
  vinculo_equipamento?: "tarefa" | "projeto";
};

export function normalizeAuvoTask(task: JsonRecord, context: ProjectTaskContext = {}) {
  const id = numericId(task.taskID ?? task.taskId ?? task.id);
  const attachments = normalizeAttachments(task);
  const apiTaskUrl = validHttpUrl(task.taskUrl) ?? validHttpUrl(context.tarefa_url);
  const fallbackTaskUrl = id
    ? `https://app.auvo.com.br/relatorioTarefas/DetalheTarefa/${id}`
    : null;
  const taskUrl = apiTaskUrl ?? fallbackTaskUrl;
  return {
    id,
    external_id: task.externalId ?? task.externalCode ?? null,
    cliente: {
      id: numericId(task.customerId ?? task.customerCode),
      nome: task.customerDescription ?? task.customerName ?? null,
    },
    tecnico: {
      id: numericId(task.idUserTo),
      nome: task.userToName ?? null,
    },
    tipo: {
      id: numericId(task.taskType ?? task.taskTypeCode),
      nome: task.taskTypeDescription ?? null,
    },
    data: task.taskDate ?? null,
    criacao: task.creationDate ?? null,
    atualizacao: task.dateLastUpdate ?? null,
    status: TASK_STATUS[Number(task.taskStatus)] ?? task.status ?? null,
    finalizada: task.finished ?? null,
    orientacao: task.orientation ?? null,
    relatorio: task.report ?? null,
    pendencia: task.pendency ?? null,
    check_in: task.checkInDate ?? null,
    check_out: task.checkOutDate ?? null,
    duracao: task.duration ?? null,
    duracao_decimal: task.durationDecimal ?? null,
    equipamentos_ids: equipmentIdsFrom(task.equipmentsId ?? task.equipments),
    anexos: attachments,
    fotos: attachments.filter((attachment) => attachment.tipo === "foto"),
    questionarios: Array.isArray(task.questionnaires) ? task.questionnaires : [],
    produtos: Array.isArray(task.products) ? task.products : [],
    servicos: Array.isArray(task.services) ? task.services : [],
    custos_adicionais: Array.isArray(task.additionalCosts) ? task.additionalCosts : [],
    ticket: task.ticketId
      ? { id: task.ticketId, titulo: task.ticketTitle ?? null }
      : null,
    links: {
      tarefa_relatorio: taskUrl,
      tarefa_relatorio_fonte: apiTaskUrl ? "auvo_api" : fallbackTaskUrl ? "padrao_oficial" : null,
      relatorio_os: validHttpUrl(context.relatorio_os_url),
      relatorio_os_detalhado: validHttpUrl(context.relatorio_os_detalhado_url),
      assinatura: validHttpUrl(task.signatureUrl),
      pesquisa_satisfacao: validHttpUrl(task.survey),
    },
    ordem_servico_auvo: context.ordem_servico_auvo_id
      ? {
          id: context.ordem_servico_auvo_id,
          codigo: context.ordem_servico_auvo_codigo ?? null,
        }
      : null,
    vinculo_equipamento: context.vinculo_equipamento ?? null,
  };
}

function localDateIso(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function defaultTaskPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - 5);
  return { start: localDateIso(start), end: localDateIso(now) };
}

async function withSoftTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function handle<T extends object>(
  ctx: ToolContext,
  options: Parameters<typeof runAudited<T>>[1],
  operation: Parameters<typeof runAudited<T>>[2],
) {
  return runAudited(ctx, options, operation)
    .then(({ data, requestId }) =>
      auvoSuccessResult({ ok: true, request_id: requestId, ...data }),
    )
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
  description:
    "Consulta uma tarefa específica no Auvo pelo taskID e devolve relatório, equipamentos, fotos, anexos, questionários e links reais.",
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
        return {
          tarefa: normalizeAuvoTask(auvoResult<JsonRecord>(response)),
          source: "auvo_live",
        };
      },
    ),
});

export const buscarTarefasPorEquipamentoAuvo = defineTool({
  name: "buscar_tarefas_por_equipamento_auvo",
  title: "Buscar tarefas e fotos por equipamento no Auvo",
  description:
    "Localiza o histórico real de tarefas de um equipamento no Auvo. Resolve tarefas vinculadas ao equipamento, fotos/anexos, relatório da tarefa e links de relatório da OS. Use depois de buscar_equipamentos.",
  inputSchema: {
    equipamento_auvo_id: z.number().int().positive(),
    data_inicio: z.string().date().optional(),
    data_fim: z.string().date().optional(),
    status: z
      .enum(["abertas", "finalizadas", "todas", "com_pendencia", "iniciadas_ou_encerradas"])
      .default("todas"),
    limite: z.number().int().min(1).max(20).default(10),
    max_paginas: z.number().int().min(1).max(20).default(10),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    handle(
      ctx,
      {
        toolName: "buscar_tarefas_por_equipamento_auvo",
        operationType: "read",
        sourceSystem: "auvo",
        allowedRoles: READ_ROLES,
        parameters: input,
        targetEntity: "tarefa_equipamento_auvo",
      },
      async () => {
        const equipmentResponse = await auvoRequest<unknown>(
          `/equipments/${input.equipamento_auvo_id}`,
        );
        const equipment = auvoResult<JsonRecord>(equipmentResponse);
        const customerId = numericId(
          equipment.associatedCustomerId ?? equipment.customerId ?? equipment.idCustomer,
        );
        const defaults = defaultTaskPeriod();
        const startDate = input.data_inicio ?? defaults.start;
        const endDate = input.data_fim ?? defaults.end;
        if (startDate > endDate) {
          throw new McpToolError(
            "INVALID_INPUT",
            "data_inicio deve ser anterior ou igual a data_fim.",
          );
        }

        const statusFilter = {
          abertas: 0,
          finalizadas: 3,
          todas: 4,
          com_pendencia: 5,
          iniciadas_ou_encerradas: 6,
        }[input.status];
        const taskMatchesScope = (task: JsonRecord) => {
          const taskDate = String(task.taskDate ?? "").slice(0, 10);
          if (taskDate && (taskDate < startDate || taskDate > endDate)) return false;
          if (statusFilter !== 4 && Number(task.taskStatus) !== statusFilter) return false;
          const ids = equipmentIdsFrom(task.equipmentsId ?? task.equipments);
          return ids.length === 0 || ids.includes(input.equipamento_auvo_id);
        };

        const projectResponse = await withSoftTimeout(
          auvoRequest<unknown>(
            auvoListPath(
              "serviceorders",
              { EquipmentCode: String(input.equipamento_auvo_id) },
              1,
              100,
              "desc",
            ),
          ).catch(() => null),
          4_000,
        );
        const projectContexts = new Map<number, ProjectTaskContext>();
        for (const project of projectResponse ? resultList(projectResponse) : []) {
          const projectEquipmentIds = equipmentIdsFrom(project.equipments);
          for (const visit of arrayOfRecords(project.visits)) {
            const taskId = numericId(visit.taskId ?? visit.taskID ?? visit.id);
            if (!taskId) continue;
            const visitEquipmentIds = equipmentIdsFrom(
              visit.equipmentsId ?? visit.equipments,
            );
            const linkedByTask = visitEquipmentIds.includes(input.equipamento_auvo_id);
            const linkedByProject =
              projectEquipmentIds.includes(input.equipamento_auvo_id) ||
              visitEquipmentIds.length === 0;
            if (!linkedByTask && !linkedByProject) continue;
            projectContexts.set(taskId, {
              tarefa_url: visit.taskUrl,
              relatorio_os_url: project.reportLink,
              relatorio_os_detalhado_url: project.detailedReportLink,
              ordem_servico_auvo_id: project.id,
              ordem_servico_auvo_codigo: project.projectCode,
              vinculo_equipamento: linkedByTask ? "tarefa" : "projeto",
            });
          }
        }

        const taskRows = new Map<number, JsonRecord>();
        const directProjectTaskIds = [...projectContexts.keys()].slice(
          0,
          Math.max(input.limite * 2, 5),
        );
        const directProjectDetails = await Promise.all(
          directProjectTaskIds.map(async (taskId) => {
            try {
              const response = await auvoRequest<unknown>(`/tasks/${taskId}`);
              return [taskId, auvoResult<JsonRecord>(response)] as const;
            } catch {
              return null;
            }
          }),
        );
        for (const detail of directProjectDetails) {
          if (detail && taskMatchesScope(detail[1])) taskRows.set(detail[0], detail[1]);
        }

        let pagesRead = 0;
        let totalTasksInScope: number | null = null;
        if (customerId && taskRows.size === 0) {
          let cursorEnd = endDate;
          const monthWindowLimit =
            !input.data_inicio && !input.data_fim
              ? Math.max(input.max_paginas, 12)
              : input.max_paginas;
          for (let page = 1; page <= monthWindowLimit; page += 1) {
            const cursorDate = new Date(`${cursorEnd}T00:00:00Z`);
            const monthStart = `${cursorDate.getUTCFullYear()}-${String(
              cursorDate.getUTCMonth() + 1,
            ).padStart(2, "0")}-01`;
            const windowStart = monthStart < startDate ? startDate : monthStart;
            const response = await withSoftTimeout(
              auvoRequest<unknown>(
                auvoListPath(
                  "tasks",
                  {
                    startDate: `${windowStart}T00:00:00`,
                    endDate: `${cursorEnd}T23:59:59`,
                    customerId,
                    status: statusFilter,
                  },
                  1,
                  100,
                  "desc",
                ),
              ).catch(() => null),
              8_000,
            );
            pagesRead = page;
            if (!response) {
              if (windowStart === startDate) break;
              cursorDate.setUTCDate(0);
              cursorEnd = cursorDate.toISOString().slice(0, 10);
              continue;
            }
            totalTasksInScope = (totalTasksInScope ?? 0) + (resultTotal(response) ?? 0);
            const rows = resultList(response);
            for (const row of rows) {
              const taskId = numericId(row.taskID ?? row.taskId ?? row.id);
              if (!taskId) continue;
              const ids = equipmentIdsFrom(row.equipmentsId ?? row.equipments);
              if (ids.includes(input.equipamento_auvo_id) && taskMatchesScope(row)) {
                taskRows.set(taskId, row);
              }
            }
            if (taskRows.size >= input.limite || windowStart === startDate) break;
            cursorDate.setUTCDate(0);
            cursorEnd = cursorDate.toISOString().slice(0, 10);
          }
        }

        const missingDetails = [...projectContexts.keys()]
          .filter((taskId) => !taskRows.has(taskId))
          .slice(0, input.limite);
        const detailResults = await Promise.all(
          missingDetails.map(async (taskId) => {
            try {
              const response = await auvoRequest<unknown>(`/tasks/${taskId}`);
              return [taskId, auvoResult<JsonRecord>(response)] as const;
            } catch {
              return null;
            }
          }),
        );
        for (const detail of detailResults) {
          if (detail && taskMatchesScope(detail[1])) taskRows.set(detail[0], detail[1]);
        }

        const tasks = [...taskRows.entries()]
          .map(([taskId, task]) =>
            normalizeAuvoTask(task, projectContexts.get(taskId)),
          )
          .sort((left, right) =>
            String(right.data ?? "").localeCompare(String(left.data ?? "")),
          )
          .slice(0, input.limite);
        const taskIds = new Set(tasks.map((task) => task.id).filter(Boolean));
        const projectsWithoutDetails = [...projectContexts.entries()]
          .filter(([taskId]) => !taskIds.has(taskId))
          .slice(0, Math.max(0, input.limite - tasks.length))
          .map(([taskId, context]) =>
            normalizeAuvoTask({ taskID: taskId }, context),
          );
        const combinedTasks = [...tasks, ...projectsWithoutDetails]
          .sort((left, right) =>
            String(right.data ?? "").localeCompare(String(left.data ?? "")),
          )
          .slice(0, input.limite);

        const taskSearchTruncated =
          totalTasksInScope !== null && pagesRead * 100 < totalTasksInScope;
        return {
          status: combinedTasks.length ? "found" : "not_found",
          equipamento: {
            id: input.equipamento_auvo_id,
            nome: equipment.name ?? null,
            identificador: equipment.identifier ?? null,
            descricao: equipment.description ?? null,
            cliente_auvo_id: customerId,
          },
          periodo_consultado: {
            inicio: startDate,
            fim: endDate,
            padrao_aplicado: !input.data_inicio && !input.data_fim,
          },
          tarefas: combinedTasks,
          quantidade: combinedTasks.length,
          paginas_tarefas_lidas: pagesRead,
          busca_parcial: taskSearchTruncated,
          aviso: taskSearchTruncated
            ? "Há mais tarefas do cliente fora das páginas lidas. Informe um período menor ou aumente max_paginas para ampliar a busca."
            : null,
          source: "auvo_live",
        };
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
  buscarTarefasPorEquipamentoAuvo,
  listarTecnicosAuvo,
  listarTiposTarefaAuvo,
  prepararCriacaoTarefaAuvo,
  confirmarCriacaoTarefaAuvo,
];
