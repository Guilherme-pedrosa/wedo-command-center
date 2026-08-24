export type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

/**
 * O endpoint interno do GC usa uma chave literal com ponto:
 * { data: { "request.data": { ...produto } } }.
 * Mantemos também o fallback antigo para não quebrar outra versão do endpoint.
 */
export function unwrapGcInternalProduct(value: unknown): JsonRecord | null {
  const root = asRecord(value);
  const data = asRecord(root?.data);
  if (!data) return null;

  const literalRequestData = asRecord(data["request.data"]);
  if (literalRequestData) return literalRequestData;

  const request = asRecord(data.request);
  return asRecord(request?.data);
}

export function internalProductTax(value: JsonRecord | null): JsonRecord | null {
  if (!value) return null;
  const raw = value.ProdutosTributacao;
  if (Array.isArray(raw)) return asRecord(raw[0]);
  return asRecord(raw);
}

/**
 * O GET do GC devolve ProdutosTributacao como array, mas a tela oficial executa
 * `ProdutosTributacao = ProdutosTributacao[0]` antes de fazer o POST. Repetimos
 * exatamente essa normalização para o endpoint aceitar a alteração fiscal.
 */
export function mergeGcInternalFiscal(
  product: JsonRecord,
  ncm: string,
  origem: string,
): JsonRecord {
  const currentTax = internalProductTax(product) ?? {};
  const updatedTax: JsonRecord = {
    ...currentTax,
    NCM: ncm || String(currentTax.NCM ?? ""),
    ICMS_orig: origem,
  };

  return {
    ...product,
    ProdutosTributacao: updatedTax,
  };
}
