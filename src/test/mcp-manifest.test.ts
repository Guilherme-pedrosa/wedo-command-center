import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), ".lovable/mcp/manifest.json"), "utf8"),
);
const toolNames = manifest.mcp.tools.map((tool: { name: string }) => tool.name);

describe("catálogo MCP publicado", () => {
  it("expõe ferramentas operacionais específicas de GestãoClick e Auvo", () => {
    expect(manifest.mcp.server.name).toBe("wedo-operacoes");
    expect(toolNames).toContain("buscar_cliente");
    expect(toolNames).toContain("preparar_criacao_cliente");
    expect(toolNames).toContain("confirmar_criacao_cliente");
    expect(toolNames).toContain("preparar_edicao_cliente");
    expect(toolNames).toContain("confirmar_edicao_cliente");
    expect(toolNames).toContain("preparar_criacao_produto_servico");
    expect(toolNames).toContain("confirmar_criacao_produto_servico");
    expect(toolNames).toContain("buscar_vendas");
    expect(toolNames).toContain("detalhar_venda");
    expect(toolNames).toContain("listar_situacoes_venda");
    expect(toolNames).toContain("preparar_criacao_venda");
    expect(toolNames).toContain("confirmar_criacao_venda");
    expect(toolNames).toContain("preparar_criacao_orcamento");
    expect(toolNames).toContain("confirmar_criacao_orcamento");
    expect(toolNames).toContain("consultar_estoque");
    expect(toolNames).toContain("buscar_equipamentos");
    expect(toolNames).toContain("consultar_tarefa_auvo");
    expect(toolNames).toContain("preparar_criacao_ordem_servico");
    expect(toolNames).toContain("confirmar_criacao_ordem_servico");
  });

  it("não expõe proxy, URL, método HTTP ou exclusões arbitrárias ao modelo", () => {
    expect(toolNames).not.toContain("gc_proxy");
    expect(toolNames).not.toContain("http_request");
    expect(toolNames).not.toContain("executar_endpoint");
    expect(toolNames.some((name: string) => name.includes("excluir"))).toBe(false);
  });

  it("mantém cada gravação em duas etapas", () => {
    for (const confirmTool of toolNames.filter((name: string) => name.startsWith("confirmar_"))) {
      expect(toolNames).toContain(confirmTool.replace("confirmar_", "preparar_"));
    }
  });
});
