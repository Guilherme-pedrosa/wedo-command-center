// ════════════════════════════════════════════════════════════════════════════
// Motor único de cálculo da Negociação — 100% em centavos (inteiros).
// ATENÇÃO: este arquivo é a fonte da verdade e é copiado byte-a-byte para
// supabase/functions/_shared/negociacao-plano.ts (validado por teste).
// Não adicione imports aqui: precisa rodar em browser (Vite) e em Deno.
// ════════════════════════════════════════════════════════════════════════════

export type OrigemTipo = "os" | "residuo";

export interface OrigemNegociacao {
  id: string;
  tipo: OrigemTipo;
  codigo?: string | null;
  /** Valor de face da origem, em centavos. */
  valorCents: number;
  /** Quanto dessa origem já foi pago/recebido antes, em centavos. */
  pagoCents?: number;
  clienteGcId?: string | null;
  gcRecebimentoId?: string | null;
  estado?: string | null;
}

export interface PendenciaPlano {
  codigo: string;
  motivo: string;
  origemId?: string;
}

export interface AlocacaoOrigem {
  origemId: string;
  tipo: OrigemTipo;
  codigo?: string | null;
  saldoCents: number;
  alocadoCents: number;
  restanteCents: number;
}

export interface ComposicaoParcela {
  origemId: string;
  tipo: OrigemTipo;
  valorCents: number;
}

export interface ParcelaPlano {
  numero: number;
  vencimento: string;
  valorCents: number;
  composicao: ComposicaoParcela[];
}

export interface PlanoInput {
  origens: OrigemNegociacao[];
  parcelas: number;
  diaVencimento: number;
  /** YYYY-MM */
  mesInicio: string;
  /** Montante efetivamente negociado; ausente/<=0 = saldo integral das origens. */
  montanteNegociadoCents?: number;
  /** Valores manuais por parcela (centavos). Devem somar o montante negociado. */
  valoresParcelasCents?: number[];
  clienteGcId?: string | null;
}

export interface PlanoNegociacao {
  parcelas: ParcelaPlano[];
  alocacoes: AlocacaoOrigem[];
  vencimentos: string[];
  totalOrigensCents: number;
  totalNegociadoCents: number;
  totalRestanteCents: number;
  vencimentoRestante: string;
  pendencias: PendenciaPlano[];
  valido: boolean;
}

// ─────────────────────────── dinheiro ───────────────────────────

export function moneyToCents(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100);
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

export function centsToMoney(cents: number): number {
  return Math.round(cents) / 100;
}

export function splitEvenlyCents(totalCents: number, parts: number): number[] {
  if (parts <= 0) return [];
  const base = Math.floor(totalCents / parts);
  const remainder = totalCents - base * parts;
  // A última parcela absorve o arredondamento (regra do projeto).
  return Array.from({ length: parts }, (_, index) =>
    index === parts - 1 ? base + remainder : base
  );
}

export function allocateProportionallyCents(totalCents: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sanitized = weights.map((w) => Math.max(0, Math.trunc(w)));
  const totalWeight = sanitized.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) return splitEvenlyCents(totalCents, weights.length);

  const raw = sanitized.map((w) => (totalCents * w) / totalWeight);
  const out = raw.map((v) => Math.floor(v));
  let remainder = totalCents - out.reduce((sum, v) => sum + v, 0);

  const order = raw
    .map((v, index) => ({ index, fraction: v - out[index], weight: sanitized[index] }))
    .sort((a, b) => b.fraction - a.fraction || b.weight - a.weight || a.index - b.index);

  for (let cursor = 0; remainder > 0; cursor += 1) {
    out[order[cursor % order.length].index] += 1;
    remainder -= 1;
  }
  return out;
}

// ─────────────────────────── datas ───────────────────────────

export function ultimoDiaDoMes(ano: number, mes1a12: number): number {
  return new Date(Date.UTC(ano, mes1a12, 0)).getUTCDate();
}

/**
 * Gera vencimentos ancorando no dia pedido e "grudando" no último dia do mês
 * quando o mês é mais curto: dia 31 a partir de jan/2026 →
 * 31/01, 28/02, 31/03. Em ano bissexto fevereiro vira 29/02.
 */
export function gerarVencimentos(mesInicio: string, diaVencimento: number, parcelas: number): string[] {
  const [anoStr, mesStr] = String(mesInicio || "").split("-");
  const ano = Number(anoStr);
  const mes = Number(mesStr);
  if (!Number.isFinite(ano) || !Number.isFinite(mes) || parcelas <= 0) return [];

  const diaAlvo = Math.min(Math.max(Math.trunc(diaVencimento) || 1, 1), 31);
  const out: string[] = [];
  for (let i = 0; i < parcelas; i += 1) {
    const totalMeses = mes - 1 + i;
    const anoAtual = ano + Math.floor(totalMeses / 12);
    const mesAtual = (totalMeses % 12) + 1;
    const dia = Math.min(diaAlvo, ultimoDiaDoMes(anoAtual, mesAtual));
    out.push(
      `${anoAtual}-${String(mesAtual).padStart(2, "0")}-${String(dia).padStart(2, "0")}`
    );
  }
  return out;
}

/** Restante vence no último dia útil do mês seguinte à última parcela. */
export function calcularVencimentoRestante(ultimoVencimento: string): string {
  if (!ultimoVencimento) return "";
  const [ano, mes] = ultimoVencimento.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes + 1, 0));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ─────────────────────────── plano ───────────────────────────

export function saldoOrigemCents(origem: OrigemNegociacao): number {
  return Math.max(0, Math.trunc(origem.valorCents) - Math.trunc(origem.pagoCents || 0));
}

/**
 * Distribui `alocado` de cada origem entre as parcelas preservando
 * simultaneamente a soma por parcela e a soma por origem.
 * Resíduos NUNCA caem integralmente na primeira parcela: a distribuição é
 * proporcional ao tamanho de cada parcela.
 */
function distribuirMatriz(alocados: number[], parcelasCents: number[]): number[][] {
  const totalParcelas = parcelasCents.reduce((s, v) => s + v, 0);
  const matriz = alocados.map(() => parcelasCents.map(() => 0));
  if (totalParcelas <= 0) return matriz;

  const fracoes = alocados.map((a) => parcelasCents.map((p) => (a * p) / totalParcelas));
  for (let o = 0; o < alocados.length; o += 1) {
    for (let j = 0; j < parcelasCents.length; j += 1) {
      matriz[o][j] = Math.floor(fracoes[o][j]);
    }
  }

  const faltaLinha = parcelasCents.map(
    (p, j) => p - matriz.reduce((s, row) => s + row[j], 0)
  );
  const faltaOrigem = alocados.map(
    (a, o) => a - matriz[o].reduce((s, v) => s + v, 0)
  );

  for (let j = 0; j < parcelasCents.length; j += 1) {
    while (faltaLinha[j] > 0) {
      const candidatos = alocados
        .map((_, o) => ({ o, falta: faltaOrigem[o], fracao: fracoes[o][j] - Math.floor(fracoes[o][j]) }))
        .filter((c) => c.falta > 0)
        .sort((a, b) => b.fracao - a.fracao || b.falta - a.falta || a.o - b.o);
      if (candidatos.length === 0) break;
      const alvo = candidatos[0].o;
      matriz[alvo][j] += 1;
      faltaOrigem[alvo] -= 1;
      faltaLinha[j] -= 1;
    }
  }

  return matriz;
}

export function construirPlano(input: PlanoInput): PlanoNegociacao {
  const pendencias: PendenciaPlano[] = [];
  const origens = (input.origens || []).filter((o) => o && o.id);
  const parcelasQtd = Math.trunc(input.parcelas || 0);

  const saldos = origens.map(saldoOrigemCents);
  const totalOrigensCents = saldos.reduce((s, v) => s + v, 0);

  origens.forEach((origem, index) => {
    if (saldos[index] <= 0) {
      pendencias.push({
        codigo: "origem_sem_saldo",
        origemId: origem.id,
        motivo: `Origem ${origem.codigo || origem.id} não tem saldo aberto (valor ${centsToMoney(origem.valorCents).toFixed(2)}, pago ${centsToMoney(origem.pagoCents || 0).toFixed(2)}).`,
      });
    }
    if (
      input.clienteGcId &&
      origem.clienteGcId &&
      String(origem.clienteGcId) !== String(input.clienteGcId)
    ) {
      pendencias.push({
        codigo: "origem_outro_cliente",
        origemId: origem.id,
        motivo: `Origem ${origem.codigo || origem.id} pertence a outro cliente (${origem.clienteGcId}).`,
      });
    }
  });

  if (parcelasQtd <= 0) {
    pendencias.push({ codigo: "parcelas_invalidas", motivo: "Número de parcelas deve ser maior que zero." });
  }

  const pedido = Math.trunc(input.montanteNegociadoCents || 0);
  let montanteNegociadoCents = pedido > 0 ? pedido : totalOrigensCents;
  if (montanteNegociadoCents > totalOrigensCents) {
    pendencias.push({
      codigo: "montante_acima_do_saldo",
      motivo: `Valor negociado (${centsToMoney(montanteNegociadoCents).toFixed(2)}) é maior que o saldo das origens (${centsToMoney(totalOrigensCents).toFixed(2)}).`,
    });
    montanteNegociadoCents = totalOrigensCents;
  }

  const alocadosCents = allocateProportionallyCents(montanteNegociadoCents, saldos);
  const alocacoes: AlocacaoOrigem[] = origens.map((origem, index) => ({
    origemId: origem.id,
    tipo: origem.tipo,
    codigo: origem.codigo ?? null,
    saldoCents: saldos[index],
    alocadoCents: alocadosCents[index] ?? 0,
    restanteCents: Math.max(0, saldos[index] - (alocadosCents[index] ?? 0)),
  }));

  let parcelasCents: number[];
  if (Array.isArray(input.valoresParcelasCents) && input.valoresParcelasCents.length === parcelasQtd) {
    parcelasCents = input.valoresParcelasCents.map((v) => Math.trunc(v));
    const soma = parcelasCents.reduce((s, v) => s + v, 0);
    if (soma !== montanteNegociadoCents) {
      pendencias.push({
        codigo: "parcelas_nao_somam",
        motivo: `Soma das parcelas (${centsToMoney(soma).toFixed(2)}) diverge do valor negociado (${centsToMoney(montanteNegociadoCents).toFixed(2)}).`,
      });
    }
  } else {
    parcelasCents = splitEvenlyCents(montanteNegociadoCents, parcelasQtd);
  }

  const vencimentos = gerarVencimentos(input.mesInicio, input.diaVencimento, parcelasQtd);
  if (vencimentos.length !== parcelasQtd) {
    pendencias.push({ codigo: "vencimentos_invalidos", motivo: "Não foi possível gerar os vencimentos (mês inicial inválido)." });
  }

  const matriz = distribuirMatriz(alocadosCents, parcelasCents);
  const parcelas: ParcelaPlano[] = parcelasCents.map((valorCents, j) => ({
    numero: j + 1,
    vencimento: vencimentos[j] || "",
    valorCents,
    composicao: origens
      .map((origem, o) => ({ origemId: origem.id, tipo: origem.tipo, valorCents: matriz[o]?.[j] ?? 0 }))
      .filter((c) => c.valorCents > 0),
  }));

  const totalRestanteCents = alocacoes.reduce((s, a) => s + a.restanteCents, 0);
  const plano: PlanoNegociacao = {
    parcelas,
    alocacoes,
    vencimentos,
    totalOrigensCents,
    totalNegociadoCents: montanteNegociadoCents,
    totalRestanteCents,
    vencimentoRestante: calcularVencimentoRestante(vencimentos[vencimentos.length - 1] || ""),
    pendencias,
    valido: false,
  };

  plano.pendencias.push(...validarPlano(plano));
  plano.valido = plano.pendencias.length === 0;
  return plano;
}

/** Invariantes duras: alocações = parcelas = valor negociado; origem = alocado + restante. */
export function validarPlano(plano: PlanoNegociacao): PendenciaPlano[] {
  const problemas: PendenciaPlano[] = [];

  const somaAloc = plano.alocacoes.reduce((s, a) => s + a.alocadoCents, 0);
  const somaParcelas = plano.parcelas.reduce((s, p) => s + p.valorCents, 0);

  if (somaAloc !== plano.totalNegociadoCents) {
    problemas.push({
      codigo: "invariante_alocacao",
      motivo: `Alocações (${centsToMoney(somaAloc).toFixed(2)}) não somam o valor negociado (${centsToMoney(plano.totalNegociadoCents).toFixed(2)}).`,
    });
  }
  if (somaParcelas !== plano.totalNegociadoCents) {
    problemas.push({
      codigo: "invariante_parcelas",
      motivo: `Parcelas (${centsToMoney(somaParcelas).toFixed(2)}) não somam o valor negociado (${centsToMoney(plano.totalNegociadoCents).toFixed(2)}).`,
    });
  }

  for (const alocacao of plano.alocacoes) {
    if (alocacao.alocadoCents + alocacao.restanteCents !== alocacao.saldoCents) {
      problemas.push({
        codigo: "invariante_origem",
        origemId: alocacao.origemId,
        motivo: `Origem ${alocacao.codigo || alocacao.origemId}: alocado + restante ≠ saldo.`,
      });
    }
    const naComposicao = plano.parcelas.reduce(
      (s, p) => s + (p.composicao.find((c) => c.origemId === alocacao.origemId)?.valorCents ?? 0),
      0
    );
    if (naComposicao !== alocacao.alocadoCents) {
      problemas.push({
        codigo: "invariante_composicao",
        origemId: alocacao.origemId,
        motivo: `Origem ${alocacao.codigo || alocacao.origemId}: composição das parcelas (${centsToMoney(naComposicao).toFixed(2)}) ≠ alocado (${centsToMoney(alocacao.alocadoCents).toFixed(2)}).`,
      });
    }
  }

  for (const parcela of plano.parcelas) {
    const soma = parcela.composicao.reduce((s, c) => s + c.valorCents, 0);
    if (soma !== parcela.valorCents) {
      problemas.push({
        codigo: "invariante_parcela_composicao",
        motivo: `Parcela ${parcela.numero}: composição (${centsToMoney(soma).toFixed(2)}) ≠ valor da parcela (${centsToMoney(parcela.valorCents).toFixed(2)}).`,
      });
    }
    if (!parcela.vencimento) {
      problemas.push({ codigo: "parcela_sem_vencimento", motivo: `Parcela ${parcela.numero} sem vencimento.` });
    }
  }

  return problemas;
}

/**
 * Identidade de título: valor+data NUNCA bastam. Exige coincidência de
 * OS/cliente/negociação/parcela e recusa quando há mais de um candidato.
 */
export interface CandidatoTitulo {
  gcId: string;
  descricao?: string | null;
  osCodigo?: string | null;
  clienteGcId?: string | null;
  valorCents: number;
  dataVencimento?: string | null;
  negociacaoNumero?: number | null;
  parcelaNumero?: number | null;
}

export interface AlvoTitulo {
  osCodigo?: string | null;
  clienteGcId?: string | null;
  valorCents: number;
  dataVencimento?: string | null;
  negociacaoNumero?: number | null;
  parcelaNumero?: number | null;
  /** true = estamos procurando o passivo/restante, não a parcela. */
  restante?: boolean;
}

export function identificarTitulo(
  alvo: AlvoTitulo,
  candidatos: CandidatoTitulo[]
): { gcId: string | null; pendencia?: PendenciaPlano } {
  const compativeis = candidatos.filter((candidato) => {
    if (candidato.valorCents !== alvo.valorCents) return false;
    if (alvo.dataVencimento && candidato.dataVencimento && candidato.dataVencimento !== alvo.dataVencimento) return false;
    if (alvo.clienteGcId && candidato.clienteGcId && String(candidato.clienteGcId) !== String(alvo.clienteGcId)) return false;
    // OS é obrigatória para identificar: título de outra OS com mesmo valor/data não serve.
    if (alvo.osCodigo) {
      const desc = String(candidato.descricao || "");
      const mesmaOs =
        (candidato.osCodigo && String(candidato.osCodigo) === String(alvo.osCodigo)) ||
        new RegExp(`OS\\s*0*${alvo.osCodigo}(\\D|$)`, "i").test(desc);
      if (!mesmaOs) return false;
    }
    if (alvo.negociacaoNumero && candidato.negociacaoNumero && candidato.negociacaoNumero !== alvo.negociacaoNumero) {
      return false;
    }
    // Passivo/restante e parcela podem ter o mesmo valor e a mesma data:
    // a natureza do título precisa bater, senão não associa.
    const pareceRestante = /passivo|restante|res[íi]duo/i.test(String(candidato.descricao || ""));
    if (Boolean(alvo.restante) !== pareceRestante) return false;
    if (!alvo.restante && alvo.parcelaNumero && candidato.parcelaNumero && candidato.parcelaNumero !== alvo.parcelaNumero) {
      return false;
    }

    return true;
  });

  if (compativeis.length === 1) return { gcId: compativeis[0].gcId };
  if (compativeis.length === 0) {
    return {
      gcId: null,
      pendencia: {
        codigo: "titulo_nao_identificado",
        motivo: `Nenhum título do GC casa com OS ${alvo.osCodigo ?? "?"} / ${alvo.dataVencimento ?? "?"} / ${centsToMoney(alvo.valorCents).toFixed(2)}.`,
      },
    };
  }
  return {
    gcId: null,
    pendencia: {
      codigo: "titulo_ambiguo",
      motivo: `${compativeis.length} títulos do GC casam com OS ${alvo.osCodigo ?? "?"} / ${alvo.dataVencimento ?? "?"} / ${centsToMoney(alvo.valorCents).toFixed(2)}; identificação bloqueada.`,
    },
  };
}
