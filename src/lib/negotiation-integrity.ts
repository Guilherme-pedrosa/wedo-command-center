/** Historic repairs stored text; integrity triggers store structured reasons. */
export function negotiationReviewReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(reason => {
    if (typeof reason === "string") return reason;
    if (reason && typeof reason === "object") {
      const record = reason as Record<string, unknown>;
      return String(record.mensagem ?? record.motivo ?? record.message ?? record.codigo ?? "Conferência financeira pendente");
    }
    return "Conferência financeira pendente";
  });
}
