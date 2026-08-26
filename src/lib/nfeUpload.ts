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

export interface XmlExtraido {
  nome: string;
  blob: Blob;
}

export interface ResultadoExtracao {
  xmls: XmlExtraido[];
  totalEntradas: number;
  zipsAninhados: number;
}

/** Lotes da SEFAZ costumam vir com ZIP dentro de ZIP; 4 níveis cobrem o caso real. */
const PROFUNDIDADE_MAX_ZIP = 4;

/**
 * Abre um .zip (recursivamente) e devolve todos os .xml encontrados.
 *
 * Extraído da tela de Precificação para que a Apuração use o mesmo código —
 * dois extratores divergem em silêncio e a divergência só aparece quando
 * falta nota na guia.
 */
export async function extrairXmlsDeZip(
  arquivo: File | Blob,
  caminhoBase = "",
  profundidade = 0,
): Promise<ResultadoExtracao> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(arquivo);
  const xmls: XmlExtraido[] = [];
  let totalEntradas = 0;
  let zipsAninhados = 0;

  const entradas = Object.entries(zip.files).filter(([, e]) => !e.dir);
  totalEntradas += entradas.length;

  for (const [nome, entrada] of entradas) {
    const minusculo = nome.toLowerCase();

    if (minusculo.endsWith(".xml")) {
      xmls.push({ nome: `${caminhoBase}${nome}`, blob: await entrada.async("blob") });
      continue;
    }

    if (minusculo.endsWith(".zip") && profundidade < PROFUNDIDADE_MAX_ZIP) {
      zipsAninhados++;
      const aninhado = await extrairXmlsDeZip(
        await entrada.async("blob"),
        `${caminhoBase}${nome.replace(/\.zip$/i, "")}/`,
        profundidade + 1,
      );
      xmls.push(...aninhado.xmls);
      totalEntradas += aninhado.totalEntradas;
      zipsAninhados += aninhado.zipsAninhados;
    }
  }

  return { xmls, totalEntradas, zipsAninhados };
}

/** Aceita .xml solto e .zip, devolvendo a lista achatada de XMLs. */
export async function coletarXmls(arquivos: File[]): Promise<ResultadoExtracao> {
  const xmls: XmlExtraido[] = [];
  let totalEntradas = 0;
  let zipsAninhados = 0;

  for (const arquivo of arquivos) {
    const nome = arquivo.name.toLowerCase();
    if (nome.endsWith(".zip")) {
      const r = await extrairXmlsDeZip(arquivo);
      xmls.push(...r.xmls);
      totalEntradas += r.totalEntradas;
      zipsAninhados += r.zipsAninhados;
    } else if (nome.endsWith(".xml")) {
      xmls.push({ nome: arquivo.name, blob: arquivo });
      totalEntradas++;
    }
  }

  return { xmls, totalEntradas, zipsAninhados };
}
