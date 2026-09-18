import { parseMoney } from './analisePickPack';

/**
 * Taxa de recebimento de um título: o que a máquina de cartão ou o banco
 * ficou, e que por isso nunca chegou à conta.
 *
 * O GC tem campos para isso (`taxa_operadora`, `taxa_banco`), mas em mais de
 * mil títulos liquidados desde março/2026 nenhum os usa. A prática na WeDo é
 * lançar a taxa da máquina como `desconto` do título — e só em metade das
 * vendas no cartão: 10 de 21 títulos de crédito (R$ 18 mil brutos) não têm
 * nada lançado, e o lucro dessas sai inflado.
 *
 * A regra: o que está lançado no GC manda. Quando não há nada lançado e a
 * forma de pagamento é de cartão, a taxa é **estimada** pela tabela abaixo e
 * marcada como tal, para o lucro sair do recebível real e a conferência saber
 * que aquele número é estimativa até alguém lançar o desconto no GC.
 */

export interface TaxaForma {
  /** Trecho do nome da forma de pagamento, sem acento, comparado em maiúsculas. */
  forma: string;
  /** Percentual sobre o valor bruto do título. */
  percentual: number;
  /** Valor fixo por título (boleto, por exemplo). */
  fixo: number;
}

/**
 * Padrão calibrado nos títulos que TÊM a taxa lançada (março–setembro/2026):
 * crédito 5,81 % em média, débito 1,37 %. Link de cartão usa a mesma do
 * crédito — a média observada (15 %) vem de dois títulos parcelados e não
 * serve de regra. Tudo editável nos parâmetros da tela.
 */
export const TABELA_TAXAS_PADRAO: TaxaForma[] = [
  { forma: 'CARTAO DE CREDITO', percentual: 5.81, fixo: 0 },
  { forma: 'LINK DE CARTAO', percentual: 5.81, fixo: 0 },
  { forma: 'CARTAO DE DEBITO', percentual: 1.37, fixo: 0 },
];

export type OrigemTaxa = 'gc' | 'estimada' | 'nenhuma';

export interface TaxaTitulo {
  valor: number;
  origem: OrigemTaxa;
  /** Percentual aplicado, quando estimada. */
  percentual?: number;
  forma: string;
}

const semAcento = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();

const centavos = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** parseMoney do Pick & Pack só aceita string|number; o payload do GC é unknown. */
const dinheiro = (v: unknown) => parseMoney(typeof v === 'number' ? v : String(v ?? ''));

/** Regra da tabela que casa com a forma de pagamento do título, se houver. */
export function regraDaForma(forma: string | null | undefined, tabela: TaxaForma[]): TaxaForma | null {
  const alvo = semAcento(String(forma ?? ''));
  if (!alvo) return null;
  return tabela.find((t) => alvo.includes(semAcento(t.forma))) ?? null;
}

/**
 * Taxa de um título. `titulo` é o payload do GC (ou a linha local, que traz o
 * payload em `gc_payload_raw`).
 */
export function taxaDoTitulo(
  titulo: Record<string, unknown>,
  tabela: TaxaForma[] = TABELA_TAXAS_PADRAO,
): TaxaTitulo {
  const t = (titulo.gc_payload_raw as Record<string, unknown> | undefined) ?? titulo;
  const forma = String(t.nome_forma_pagamento ?? titulo.nome_forma_pagamento ?? '');

  const lancada = centavos(
    dinheiro(t.desconto) + dinheiro(t.taxa_banco) + dinheiro(t.taxa_operadora),
  );
  if (lancada > 0) return { valor: lancada, origem: 'gc', forma };

  const regra = regraDaForma(forma, tabela);
  if (!regra) return { valor: 0, origem: 'nenhuma', forma };

  const bruto = dinheiro(t.valor ?? titulo.valor);
  if (!(bruto > 0)) return { valor: 0, origem: 'nenhuma', forma };

  return {
    valor: centavos(bruto * regra.percentual / 100 + regra.fixo),
    origem: 'estimada',
    percentual: regra.percentual,
    forma,
  };
}

export interface ResumoTaxas {
  total: number;
  lancadas: number;
  estimadas: number;
  /** Títulos cuja taxa foi estimada, para o aviso apontar quais. */
  titulosEstimados: { forma: string; valor: number; percentual: number }[];
}

/** Soma as taxas de todos os títulos da venda, separando o que é estimativa. */
export function resumirTaxas(
  titulos: Record<string, unknown>[],
  tabela: TaxaForma[] = TABELA_TAXAS_PADRAO,
): ResumoTaxas {
  const r: ResumoTaxas = { total: 0, lancadas: 0, estimadas: 0, titulosEstimados: [] };
  for (const titulo of titulos) {
    const tx = taxaDoTitulo(titulo, tabela);
    r.total = centavos(r.total + tx.valor);
    if (tx.origem === 'gc') r.lancadas = centavos(r.lancadas + tx.valor);
    if (tx.origem === 'estimada') {
      r.estimadas = centavos(r.estimadas + tx.valor);
      r.titulosEstimados.push({ forma: tx.forma, valor: tx.valor, percentual: tx.percentual ?? 0 });
    }
  }
  return r;
}

/** Valida uma tabela vinda dos parâmetros; devolve a padrão se estiver inválida. */
export function tabelaValida(entrada: unknown): TaxaForma[] {
  if (!Array.isArray(entrada) || !entrada.length) return TABELA_TAXAS_PADRAO;
  const ok = entrada.every(
    (t) =>
      t && typeof t === 'object' &&
      typeof (t as TaxaForma).forma === 'string' && (t as TaxaForma).forma.trim() !== '' &&
      Number.isFinite((t as TaxaForma).percentual) && (t as TaxaForma).percentual >= 0 && (t as TaxaForma).percentual < 100 &&
      Number.isFinite((t as TaxaForma).fixo) && (t as TaxaForma).fixo >= 0,
  );
  return ok ? (entrada as TaxaForma[]) : TABELA_TAXAS_PADRAO;
}
