import { describe, expect, it } from "vitest";
import { centsToMoney, moneyToCents } from "@/lib/mcp/shared/money";
import { sanitizeForAudit } from "@/lib/mcp/shared/supabase";
import { canonicalJson, sha256 } from "@/lib/mcp/shared/pending-actions";
import {
  confirmarCriacaoCliente,
  confirmarEdicaoCliente,
  prepararCriacaoCliente,
  prepararEdicaoCliente,
} from "@/lib/mcp/tools/gc-client-write";
import {
  confirmarCriacaoVenda,
  prepararCriacaoVenda,
} from "@/lib/mcp/tools/gc-sale-write";
import {
  buildAuvoResourceLinks,
  buscarTarefasPorEquipamentoAuvo,
  consultarTarefaAuvo,
  normalizeAuvoTask,
} from "@/lib/mcp/tools/auvo";

describe("WeDo Operações MCP", () => {
  it("normaliza valores monetários sem erro de ponto flutuante", () => {
    expect(moneyToCents("1.234,56")).toBe(123456);
    expect(moneyToCents("1234.56")).toBe(123456);
    expect(centsToMoney(123456)).toBe("1234.56");
    expect(centsToMoney(-5)).toBe("-0.05");
  });

  it("rejeita formatos monetários ambíguos", () => {
    expect(() => moneyToCents("R$ 10,00")).toThrow("Valor monetário inválido");
    expect(() => moneyToCents("1.2.3")).toThrow("Valor monetário inválido");
  });

  it("gera hash SHA-256 determinístico para vincular confirmação e payload", async () => {
    const first = await sha256('{"cliente_id":"123"}');
    const second = await sha256('{"cliente_id":"123"}');
    const changed = await sha256('{"cliente_id":"124"}');
    expect(first).toHaveLength(64);
    expect(first).toBe(second);
    expect(first).not.toBe(changed);
  });

  it("mantém o hash do payload mesmo quando o JSONB reordena as chaves", () => {
    expect(canonicalJson({ b: 2, a: { z: 1, y: 2 } })).toBe(
      canonicalJson({ a: { y: 2, z: 1 }, b: 2 }),
    );
  });

  it("remove segredos e documentos dos parâmetros de auditoria", () => {
    expect(
      sanitizeForAudit({
        cliente_id: "123",
        cpf: "12345678900",
        access_token: "segredo",
        observacao: "ok",
      }),
    ).toEqual({
      cliente_id: "123",
      cpf: "[REDACTED]",
      access_token: "[REDACTED]",
      observacao: "ok",
    });
  });

  it("expõe criação e edição de clientes somente em fluxo de duas etapas", () => {
    expect(prepararCriacaoCliente.name).toBe("preparar_criacao_cliente");
    expect(confirmarCriacaoCliente.name).toBe("confirmar_criacao_cliente");
    expect(prepararEdicaoCliente.name).toBe("preparar_edicao_cliente");
    expect(confirmarEdicaoCliente.name).toBe("confirmar_edicao_cliente");
  });

  it("expõe venda de produto e serviço somente em fluxo de duas etapas", () => {
    expect(prepararCriacaoVenda.name).toBe("preparar_criacao_venda");
    expect(confirmarCriacaoVenda.name).toBe("confirmar_criacao_venda");
  });

  it("expõe consulta de tarefa e histórico por equipamento no Auvo", () => {
    expect(consultarTarefaAuvo.name).toBe("consultar_tarefa_auvo");
    expect(buscarTarefasPorEquipamentoAuvo.name).toBe(
      "buscar_tarefas_por_equipamento_auvo",
    );
  });

  it("normaliza fotos e links reais de uma tarefa Auvo", () => {
    const task = normalizeAuvoTask({
      taskID: 123,
      taskDate: "2026-07-24T10:00:00",
      equipmentsId: [456],
      taskStatus: 5,
      report: "Equipamento revisado.",
      attachments: [
        {
          id: "foto-1",
          url: "https://arquivos.auvo.com.br/fogao.jpg",
          attachmentType: 1,
          extension: "jpg",
        },
      ],
    });

    expect(task.equipamentos_ids).toEqual([456]);
    expect(task.status).toBe("finalizada");
    expect(task.fotos).toEqual([
      expect.objectContaining({
        url: "https://arquivos.auvo.com.br/fogao.jpg",
        tipo: "foto",
      }),
    ]);
    expect(task.links.tarefa_relatorio).toBe(
      "https://app.auvo.com.br/relatorioTarefas/DetalheTarefa/123",
    );
  });

  it("expõe fotos e relatórios Auvo como recursos MCP clicáveis", () => {
    const resources = buildAuvoResourceLinks({
      links: {
        tarefa_relatorio:
          "https://app.auvo.com.br/relatorioTarefas/DetalheTarefa/123",
      },
      questionarios: [
        {
          resposta:
            "https://auvo-producao.s3.amazonaws.com/anexos_tarefas/fogao.jpg",
        },
      ],
      url_nao_confiavel: "https://example.com/nao-expor",
    });

    expect(resources).toEqual([
      expect.objectContaining({
        type: "resource_link",
        uri: "https://app.auvo.com.br/relatorioTarefas/DetalheTarefa/123",
      }),
      expect.objectContaining({
        type: "resource_link",
        uri: "https://auvo-producao.s3.amazonaws.com/anexos_tarefas/fogao.jpg",
        mimeType: "image/jpeg",
      }),
    ]);
  });
});
