export const NFE_FILES_PER_LOT = 1000;

export function dividirNfeEmLotes<T>(
  items: readonly T[],
  tamanhoLote = NFE_FILES_PER_LOT,
): T[][] {
  if (!Number.isInteger(tamanhoLote) || tamanhoLote <= 0) {
    throw new Error("O tamanho do lote de NF-e deve ser um inteiro positivo.");
  }

  const lotes: T[][] = [];
  for (let inicio = 0; inicio < items.length; inicio += tamanhoLote) {
    lotes.push(items.slice(inicio, inicio + tamanhoLote));
  }
  return lotes;
}
