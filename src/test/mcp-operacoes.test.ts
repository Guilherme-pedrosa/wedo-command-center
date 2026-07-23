import { describe, expect, it } from "vitest";
import { centsToMoney, moneyToCents } from "@/lib/mcp/shared/money";
import { sanitizeForAudit } from "@/lib/mcp/shared/supabase";
import { canonicalJson, sha256 } from "@/lib/mcp/shared/pending-actions";

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
});
