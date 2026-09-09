// Paginação explícita para as leituras que alimentam agregados financeiros.
// O PostgREST corta em 1000 linhas por padrão: sem paginação, um mês grande ou o
// histórico anual viram silenciosamente um total menor — pior do que um erro visível.
export const PAGE_SIZE = 1000;

export interface PagedResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * Lê TODAS as páginas. O chamador deve aplicar ordenação determinística
 * (ex.: .order('id')) para as páginas não se sobreporem nem pularem linhas.
 */
export async function fetchAllRows<T>(
  makeQuery: (from: number, to: number) => PromiseLike<PagedResult<T>>,
  pageSize: number = PAGE_SIZE,
  maxPages: number = 200,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const { data, error } = await makeQuery(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
  throw new Error(`paginação excedeu ${maxPages} páginas — consulta abortada em vez de devolver total parcial`);
}

/** Deduplica pela chave canônica do registro (nunca por índice de página). */
export function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const k = key(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}
