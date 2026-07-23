import { McpToolError } from "./errors";

export function moneyToCents(value: string | number): number {
  const raw = String(value).trim();
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  if (!/^-?\d+(\.\d{1,4})?$/.test(normalized)) {
    throw new McpToolError("INVALID_INPUT", `Valor monetário inválido: ${raw}`);
  }
  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new McpToolError("INVALID_INPUT", `Valor monetário fora do limite: ${raw}`);
  }
  return cents;
}

export function centsToMoney(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new McpToolError("INVALID_INPUT", "Valor em centavos inválido.");
  }
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}
