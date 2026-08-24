export type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function numberOrZero(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isFiscalOnlyProductPayload(value: unknown): boolean {
  const payload = asRecord(value);
  if (!payload) return false;

  const origem = String(payload.origem ?? "").trim();
  if (!/^[0-8]$/.test(origem)) return false;

  const keys = Object.keys(payload);
  return keys.length > 0 && keys.every((key) => key === "ncm" || key === "origem");
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

export type InternalProductSaveResult =
  | { ok: true; payload: JsonRecord }
  | { ok: false; error: string };

/**
 * A tela oficial acrescenta estes cinco campos derivados antes de salvar.
 * Enviar apenas o objeto cru do GET pode remover lojas/fornecedores/valores.
 * Para produto composto, abortamos: a composição possui uma transformação
 * destrutiva e não deve ser reconstruída por um job de correção fiscal.
 */
export function prepareGcInternalProductForSave(
  product: JsonRecord,
  keyFactory: () => number = Math.random,
): InternalProductSaveResult {
  const produto = asRecord(product.Produto);
  const tiposValores = asArray(product.TiposValoresProduto);
  const fornecedores = asArray(product.Fornecedor);
  const lojas = asArray(product.Loja);

  if (!produto || !tiposValores || !fornecedores || !lojas) {
    return {
      ok: false,
      error: "GC não devolveu o cadastro completo exigido para salvar a aba fiscal",
    };
  }

  if (produto.possui_composicao === true || String(produto.possui_composicao ?? "0") === "1") {
    return {
      ok: false,
      error: "Produto composto exige preservação específica da composição; gravação fiscal abortada",
    };
  }

  const custoUnitario = numberOrZero(produto.valor_custo) /
    Math.max(numberOrZero(produto.quantidade_saida), 1);
  const produtosTiposValoresProduto: JsonRecord = {};

  for (const rawTipo of tiposValores) {
    const tipo = asRecord(rawTipo);
    const id = String(tipo?.id ?? "").trim();
    if (!tipo || !id) {
      return { ok: false, error: "GC devolveu uma tabela de preço sem identificador" };
    }

    const atual = asRecord(tipo.ProdutosTiposValoresProduto) ?? {};
    const lucro = numberOrZero(tipo.lucro);
    produtosTiposValoresProduto[id] = {
      ...atual,
      lucro_sugerido: tipo.lucro ?? 0,
      valor_venda_sugerido: (custoUnitario * (1 + lucro / 100)).toFixed(2),
    };
  }

  const produtosFornecedor: JsonRecord[] = [];
  for (const rawFornecedor of fornecedores) {
    const fornecedor = asRecord(rawFornecedor);
    const fornecedorId = String(fornecedor?.id ?? "").trim();
    if (!fornecedor || !fornecedorId) {
      return { ok: false, error: "GC devolveu um fornecedor sem identificador" };
    }
    produtosFornecedor.push({ fornecedor_id: fornecedorId, chave: keyFactory() });
  }

  const produtosLoja: JsonRecord[] = [];
  for (const rawLoja of lojas) {
    const loja = asRecord(rawLoja);
    const lojaId = String(loja?.id ?? "").trim();
    if (!loja || !lojaId) {
      return { ok: false, error: "GC devolveu uma loja sem identificador" };
    }
    produtosLoja.push({ id: lojaId });
  }

  return {
    ok: true,
    payload: {
      ...product,
      ProdutosTiposValoresProduto: produtosTiposValoresProduto,
      ProdutosComposicao: [],
      ProdutosFornecedor: produtosFornecedor,
      ProdutosLoja: produtosLoja,
      lotesPorLoja: product.lotesPorLoja ?? null,
    },
  };
}
