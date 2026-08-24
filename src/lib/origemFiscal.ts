export function normalizeOrigemFiscal(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.toLowerCase() === "null") return "";

  const match = normalized.match(/^([0-8])(?:\D|$)/);
  return match?.[1] ?? "";
}

/**
 * A origem no XML de entrada foi declarada pelo fornecedor emitente.
 * Quando ele informa importação direta, a WeDo adquiriu a mercadoria
 * no mercado nacional e deve usar o código correspondente a essa operação.
 */
export function origemNfParaCadastroGc(value: unknown): string {
  const origemNf = normalizeOrigemFiscal(value);

  if (origemNf === "1") return "2";
  if (origemNf === "6") return "7";
  return origemNf;
}
