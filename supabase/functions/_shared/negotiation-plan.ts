export function negotiationDueDates(month: string, day: number, parts: number): string[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(parts) || parts < 1 || parts > 60) {
    throw new Error("Mês, dia de vencimento ou quantidade de parcelas inválidos.");
  }
  const [year, firstMonth] = month.split("-").map(Number);
  if (year < 2000 || year > 2100) throw new Error("Ano de vencimento inválido.");
  return Array.from({ length: parts }, (_, index) => {
    const last = new Date(Date.UTC(year, firstMonth + index, 0));
    return new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), Math.min(day, last.getUTCDate()))).toISOString().slice(0, 10);
  });
}

export function negotiationResidualDate(lastDue: string): string {
  const last = new Date(`${lastDue}T00:00:00Z`);
  const next = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 2, 0));
  while ([0, 6].includes(next.getUTCDay())) next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}

export function negotiationCents(value: unknown): number {
  const normalized = typeof value === "number" ? value : Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1e10) throw new Error("Valor monetário inválido.");
  return Math.round(normalized * 100);
}

function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const raw = weights.map((w) => total * w / sum);
  const result = raw.map(Math.floor);
  const order = raw.map((v, i) => ({ i, fraction: v - result[i] })).sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (let left = total - result.reduce((a, b) => a + b, 0), i = 0; left > 0; left--, i++) result[order[i % order.length].i]++;
  return result;
}

export function buildNegotiationPlan(
  origins: Array<{ key: string; availableCents: number }>,
  negotiatedCents: number,
  installmentCents?: number[],
  parts = installmentCents?.length ?? 1,
) {
  const totalCents = origins.reduce((sum, o) => sum + o.availableCents, 0);
  if (!origins.length || new Set(origins.map((o) => o.key)).size !== origins.length || origins.some((o) => !o.key || !Number.isSafeInteger(o.availableCents) || o.availableCents <= 0)) throw new Error("Origem repetida, inexistente ou sem saldo.");
  if (!Number.isInteger(parts) || parts < 1 || parts > 60 || !Number.isSafeInteger(negotiatedCents) || negotiatedCents <= 0 || negotiatedCents > totalCents) throw new Error("Valor negociado excede o saldo ou parcelas são inválidas.");
  const columns = installmentCents ?? allocate(negotiatedCents, Array(parts).fill(1));
  if (columns.length !== parts || columns.some((v) => !Number.isSafeInteger(v) || v <= 0) || columns.reduce((a, b) => a + b, 0) !== negotiatedCents) throw new Error("A soma das parcelas deve ser exatamente o valor negociado.");
  const totals = allocate(negotiatedCents, origins.map((o) => o.availableCents));
  if (totals.some((v) => v === 0)) throw new Error("O valor é insuficiente para distribuir entre todas as origens selecionadas.");
  // Allocate each column against remaining row capacities. Both margins stay exact.
  const capacities = [...totals];
  const matrix = origins.map(() => Array(parts).fill(0) as number[]);
  columns.forEach((column, index) => {
    const values = allocate(column, capacities);
    values.forEach((v, row) => { matrix[row][index] = v; capacities[row] -= v; });
  });
  if (capacities.some((v) => v !== 0)) throw new Error("Falha na conservação do plano.");
  return {
    totalCents, negotiatedCents, remainingCents: totalCents - negotiatedCents, installmentCents: columns,
    origins: origins.map((origin, index) => ({ ...origin, negotiatedCents: totals[index], remainingCents: origin.availableCents - totals[index], installmentCents: matrix[index] })),
  };
}
