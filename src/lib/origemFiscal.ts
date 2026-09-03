export const ORIGENS_FISCAIS_GC = [
  { codigo: "0", descricao: "Nacional, exceto as indicadas nos códigos de 3 a 5" },
  { codigo: "1", descricao: "Estrangeira - Importação direta, exceto a indicada no código 6" },
  { codigo: "2", descricao: "Estrangeira - Adquirida no mercado interno, exceto a indicada no código 7" },
  { codigo: "3", descricao: "Nacional, mercadoria ou bem com Conteúdo de Importação superior a 40%" },
  { codigo: "4", descricao: "Nacional, produção em conformidade com processos básicos que tratam as legisl. dos Ajustes" },
  { codigo: "5", descricao: "Nacional, mercadoria ou bem com Conteúdo de Importação inferior ou igual a 40%" },
  { codigo: "6", descricao: "Estrangeira - Importação direta, sem similar nacional, constante em lista da CAMEX" },
  { codigo: "7", descricao: "Estrangeira - Adquirida no mercado interno, sem similar nacional, constante em lista da CAMEX" },
  { codigo: "8", descricao: "Nacional, mercadoria ou bem com Conteúdo de Importação superior a 70%" },
] as const;

export function normalizeOrigemFiscal(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.toLowerCase() === "null") return "";

  const match = normalized.match(/^([0-8])(?:\D|$)/);
  return match?.[1] ?? "";
}

/**
 * A NF de entrada descreve a origem sob a perspectiva do fornecedor.
 * Como a WeDo não faz importação direta, um item importado diretamente pelo
 * fornecedor passa a ser uma aquisição no mercado interno no nosso cadastro:
 * 1 -> 2 e 6 -> 7. Os demais códigos mantêm o significado original.
 */
export function origemNfParaCadastroGc(value: unknown): string {
  const origemNf = normalizeOrigemFiscal(value);
  if (origemNf === "1") return "2";
  if (origemNf === "6") return "7";
  return origemNf;
}

/** Mantém uma correção já registrada no Argus; a NF continua visível para comparação. */
export function origemRegistradaNoArgus(origemArgus: unknown, origemNf: unknown): string {
  return normalizeOrigemFiscal(origemArgus) || normalizeOrigemFiscal(origemNf);
}

export function resolverOrigemFiscal(params: {
  manual: unknown;
  nf: unknown;
  legado: unknown;
}) {
  const manual = normalizeOrigemFiscal(params.manual);
  const nf = origemNfParaCadastroGc(params.nf);
  const legado = normalizeOrigemFiscal(params.legado);

  return {
    origemEfetiva: manual || nf || legado,
    divergenciaManual: Boolean(manual && nf && manual !== nf),
    divergenciaLegada: Boolean(!manual && legado && nf && legado !== nf),
  };
}
