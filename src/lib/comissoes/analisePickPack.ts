// Adaptado do Pick & Pack, commit a21a5afc8c7d41043b9a92c7057f51e0f2c073f8.
// Mantém a apuração de orçamento; zero explícito em item bonificado é preservado.
export function parseMoney(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  if (raw.includes(',') && raw.includes('.')) return parseFloat(raw.replace(/\./g, '').replace(',', '.')) || 0;
  if (raw.includes(',')) return parseFloat(raw.replace(',', '.')) || 0;
  return parseFloat(raw) || 0;
}

export const formatBRL = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 });

export const formatPct = (v: number, digits = 1) =>
  `${v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;

// --- Config -----------------------------------------------------------------

export interface AnalysisConfig {
  /** Alíquota de impostos sobre o faturamento (%) */
  impostoPct: number;
  /** Rateio de custo fixo / despesa administrativa sobre o faturamento (%) */
  custoFixoPct: number;
  /** Provisão de garantia sobre o faturamento (%) */
  garantiaPct: number;
  /** Margem líquida mínima aceitável (%) */
  margemMinima: number;
  /** Margem líquida meta (%) */
  margemMeta: number;
  /** Custo real do deslocamento por km rodado (R$) */
  custoPorKm: number;
  /** Alimentação por dia por técnico (R$) */
  alimentacaoDia: number;
  /** Mão de obra administrativa por hora (R$) */
  moAdminHora: number;
  /** Horas administrativas consideradas por padrão */
  moAdminHorasPadrao: number;
  /** Premiação do técnico sobre peças (%) */
  premiacaoPecaPct: number;
  /** Premiação do técnico sobre serviços (%) */
  premiacaoServicoPct: number;
  /** Rendimento anual do CDB (%) — base do custo do dinheiro no parcelamento */
  cdbAnualPct: number;
}

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  impostoPct: 14,
  custoFixoPct: 0,
  garantiaPct: 0,
  margemMinima: 19,
  margemMeta: 30,
  custoPorKm: 1.05,
  alimentacaoDia: 25,
  moAdminHora: 30,
  moAdminHorasPadrao: 1,
  premiacaoPecaPct: 1,
  premiacaoServicoPct: 15,
  cdbAnualPct: 14,
};

/** Custos operacionais informados na análise (por orçamento ou por conjunto) */
export interface ExtrasInput {
  /** dias de atendimento */
  dias: number;
  /** técnicos envolvidos */
  tecnicos: number;
  considerarAlimentacao: boolean;
  considerarRestorno?: boolean;
  /** horas de mão de obra administrativa */
  horasAdmin: number;
  considerarAdmin: boolean;
  considerarPremiacao: boolean;
  /** pedágio total (R$) */
  pedagio: number;
  /** hospedagem total (R$) */
  hospedagem: number;
  /** quantidade de parcelas do pagamento */
  parcelas: number;
  considerarParcelamento: boolean;
  /** Nota 10: reduz o imposto em 10% */
  nota10: boolean;
}

// Comissão de produtos: despesas de atendimento somente quando informadas na conferência.
export function defaultExtras(cfg: AnalysisConfig): ExtrasInput {
  return {
    dias: 1,
    tecnicos: 1,
    considerarAlimentacao: false,
    considerarRestorno: false,
    horasAdmin: cfg.moAdminHorasPadrao,
    considerarAdmin: false,
    considerarPremiacao: false,
    pedagio: 0,
    hospedagem: 0,
    parcelas: 1,
    considerarParcelamento: false,
    nota10: false,
  };
}

export interface ExtrasResumo {
  alimentacao: number;
  moAdmin: number;
  premiacao: number;
  premiacaoPecas: number;
  premiacaoServicos: number;
  pedagio: number;
  hospedagem: number;
  /** Restorno Sapore (8% sobre a receita líquida) */
  restorno: number;
  restornoPct: number;
  /** Custo do dinheiro no parcelamento (CDB anual / nº de parcelas) */
  parcelamento: number;
  parcelamentoPct: number;
  parcelas: number;
  total: number;
}

/** Percentual de restorno cobrado pelo cliente Sapore */
export const RESTORNO_SAPORE_PCT = 8;

/** Identifica se o cliente é Sapore (aplica restorno) */
export function isClienteRestorno(nomeCliente: any): boolean {
  return String(nomeCliente || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .includes('sapore');
}



/** Como o custo de deslocamento entra na análise */
export type DeslocamentoModo = 'auto' | 'manual' | 'ignorar';

export interface DeslocamentoInput {
  modo: DeslocamentoModo;
  /** km usados quando modo = 'manual' */
  km: number;
  /** custo por km usado quando modo = 'manual' (se vazio usa o da config) */
  custoPorKm?: number;
}

export const DEFAULT_DESLOCAMENTO: DeslocamentoInput = { modo: 'auto', km: 0 };

export interface DeslocamentoResumo {
  modo: DeslocamentoModo;
  /** km identificados no orçamento (linhas de deslocamento) */
  kmDetectado: number;
  /** km efetivamente considerados no cálculo */
  km: number;
  custoPorKm: number;
  /** custo total estimado do deslocamento */
  custoEstimado: number;
  /** parte do custo que já vem cadastrada nas linhas do orçamento */
  custoJaNasLinhas: number;
  /** custo extra somado à análise (evita contagem dupla) */
  custoAdicional: number;
  /** receita faturada de deslocamento (pode ser 0 se houve desconto total) */
  receita: number;
  /** rótulo das linhas identificadas */
  linhas: string[];
}
export interface AnalysisLine {
  tipo: 'produto' | 'servico';
  nome: string;
  detalhes?: string;
  codigo?: string;
  tabela?: string;
  quantidade: number;
  valorUnitVenda: number;
  valorUnitCusto: number;
  receita: number;
  custo: number;
  margemBruta: number;
  margemBrutaPct: number;
  markupPct: number;
  descontoAplicado: number;
  semCusto: boolean;
  /** linha identificada como deslocamento/km */
  isDeslocamento?: boolean;
}

export interface OrcamentoAnalysis {
  id: string;
  codigo: string;
  nomeCliente: string;
  /** equipamento vinculado ao orçamento (atributo extra ou lista de equipamentos) */
  equipamento?: string;
  nomeVendedor?: string;
  data: string;
  nomeSituacao: string;
  linhas: AnalysisLine[];
  receitaProdutos: number;
  receitaServicos: number;
  /** receita de peças que gera premiação (exclui deslocamento, hospedagem e alimentação) */
  receitaPremiavelProdutos: number;
  /** receita de serviços que gera premiação (exclui deslocamento, hospedagem e alimentação) */
  receitaPremiavelServicos: number;
  receitaFrete: number;
  descontoCabecalho: number;
  receitaBruta: number;
  receitaLiquida: number;
  custoProdutos: number;
  custoServicos: number;
  custoDeslocamento: number;
  deslocamento: DeslocamentoResumo;
  custoTotal: number;

  extras: ExtrasResumo;

  imposto: number;
  /** alíquota efetiva de imposto aplicada (considera Nota 10) */
  impostoPctEfetivo: number;
  nota10: boolean;
  custoFixo: number;
  garantia: number;
  lucro: number;
  margemLiquidaPct: number;
  margemBrutaPct: number;
  descontoTotalPct: number;
  /** desconto máximo possível mantendo a margem mínima */
  descontoMaxMinima: number;
  descontoMaxMinimaPct: number;
  /** desconto máximo possível mantendo a margem meta */
  descontoMaxMeta: number;
  descontoMaxMetaPct: number;
  linhasSemCusto: number;
  valorTotalGC: number;
  config: AnalysisConfig;
}

// --- Fetch ------------------------------------------------------------------

function buildLine(raw: any, tipo: 'produto' | 'servico'): AnalysisLine {
  const quantidade = parseMoney(raw.quantidade);
  const valorUnitVenda = parseMoney(raw.valor_venda);
  const valorUnitCusto = parseMoney(raw.valor_custo);
  const receita = raw.valor_total !== undefined && raw.valor_total !== null && raw.valor_total !== ''
    ? parseMoney(raw.valor_total) : quantidade * valorUnitVenda;
  const custo = quantidade * valorUnitCusto;
  const margemBruta = receita - custo;
  const bruto = quantidade * valorUnitVenda;

  const nome = String(raw.nome_produto || raw.nome_servico || 'Item');
  const detalhes = raw.detalhes ? String(raw.detalhes) : undefined;

  return {
    tipo,
    nome,
    detalhes,
    codigo: raw.codigo_produto ? String(raw.codigo_produto) : undefined,
    tabela: raw.nome_tipo_valor ? String(raw.nome_tipo_valor) : undefined,
    quantidade,
    valorUnitVenda,
    valorUnitCusto,
    receita,
    custo,
    margemBruta,
    margemBrutaPct: receita > 0 ? (margemBruta / receita) * 100 : 0,
    markupPct: custo > 0 ? ((receita - custo) / custo) * 100 : 0,
    descontoAplicado: Math.max(0, bruto - receita),
    semCusto: valorUnitCusto <= 0,
    isDeslocamento: DESLOCAMENTO_RE.test(`${nome} ${detalhes || ''}`),
  };
}

const DESLOCAMENTO_RE = /desloc|quilometr|kilometr|\bkm\b|\bkms\b|viagem|pedágio|pedagio|combustível|combustivel/i;

/** Nome do equipamento do orçamento: campo extra "Equipamento" ou lista de equipamentos */
export function extractEquipamento(orc: any): string {
  const attr = (orc?.atributos || []).find(
    (a: any) => String(a?.atributo?.descricao || '').toLowerCase() === 'equipamento'
  );
  if (attr?.atributo?.conteudo) return String(attr.atributo.conteudo);
  const eq = (orc?.equipamentos || [])[0]?.equipamento;
  if (!eq?.equipamento) return '';
  return [eq.equipamento, eq.marca, eq.modelo].filter(Boolean).join(' · ');
}

/** Calcula os custos operacionais extras (alimentação, MO admin, premiação, pedágio, hospedagem, restorno) */
const NAO_PREMIAVEL_RE =
  /desloc|quilometr|kilometr|\bkm\b|\bkms\b|viagem|pedágio|pedagio|combustível|combustivel|hospedag|hotel|pousada|diária|diaria|aliment|refeiç|refeic|almoç|almoc|janta/i;

/** true quando a linha NÃO gera premiação (deslocamento, hospedagem, alimentação) */
export function isLinhaPremiavel(l: AnalysisLine): boolean {
  return !l.isDeslocamento && !NAO_PREMIAVEL_RE.test(`${l.nome} ${l.detalhes || ''}`);
}

/** Calcula os custos operacionais extras (alimentação, MO admin, premiação, pedágio, hospedagem, restorno) */
export function computeExtras(
  config: AnalysisConfig,
  extras: ExtrasInput,
  receitaPecas: number,
  receitaServicos: number,
  opts?: {
    nomeCliente?: string;
    receitaRestorno?: number;
    receitaFinanciamento?: number;
    /** base de premiação (exclui deslocamento, hospedagem e alimentação) */
    basePremiacaoPecas?: number;
    basePremiacaoServicos?: number;
  }
): ExtrasResumo {
  const alimentacao = extras.considerarAlimentacao
    ? Math.max(0, extras.dias) * Math.max(0, extras.tecnicos) * config.alimentacaoDia
    : 0;
  const moAdmin = extras.considerarAdmin ? Math.max(0, extras.horasAdmin) * config.moAdminHora : 0;
  const basePremPecas = opts?.basePremiacaoPecas ?? receitaPecas;
  const basePremServicos = opts?.basePremiacaoServicos ?? receitaServicos;
  const premiacaoPecas = extras.considerarPremiacao
    ? Math.max(0, basePremPecas) * (config.premiacaoPecaPct / 100)
    : 0;
  const premiacaoServicos = extras.considerarPremiacao
    ? Math.max(0, basePremServicos) * (config.premiacaoServicoPct / 100)
    : 0;
  const pedagio = Math.max(0, extras.pedagio || 0);
  const hospedagem = Math.max(0, extras.hospedagem || 0);
  const premiacao = premiacaoPecas + premiacaoServicos;

  // Restorno: 8% cobrado pelo cliente Sapore sobre o faturamento
  const aplicaRestorno = extras.considerarRestorno === true && isClienteRestorno(opts?.nomeCliente);
  const baseRestorno = Math.max(
    0,
    opts?.receitaRestorno ?? Math.max(0, receitaPecas) + Math.max(0, receitaServicos)
  );
  const restornoPct = aplicaRestorno ? RESTORNO_SAPORE_PCT : 0;
  const restorno = baseRestorno * (restornoPct / 100);

  // Parcelamento: custo do dinheiro = taxa mensal (CDB anual / 12) x prazo médio de recebimento.
  // Prazo médio de n parcelas mensais = (n - 1) / 2 meses. Em 1x (à vista) o custo é zero.
  const parcelas = Math.max(1, Math.round(extras.parcelas || 1));
  const baseFinanciamento = Math.max(
    0,
    opts?.receitaFinanciamento ?? opts?.receitaRestorno ?? Math.max(0, receitaPecas) + Math.max(0, receitaServicos)
  );
  const prazoMedioMeses = (parcelas - 1) / 2;
  const parcelamentoPct =
    extras.considerarParcelamento && parcelas > 1
      ? ((config.cdbAnualPct || 0) / 12) * prazoMedioMeses
      : 0;
  const parcelamento = baseFinanciamento * (parcelamentoPct / 100);

  return {
    alimentacao,
    moAdmin,
    premiacao,
    premiacaoPecas,
    premiacaoServicos,
    pedagio,
    hospedagem,
    restorno,
    restornoPct,
    parcelamento,
    parcelamentoPct,
    parcelas,
    total: alimentacao + moAdmin + premiacao + pedagio + hospedagem + restorno + parcelamento,
  };
}

export interface AnalysisOverrides {
  receitaProdutos?: number;
  receitaServicos?: number;
  descontoCabecalho?: number;
  custoProdutos?: number;
  custoServicos?: number;
}

export function analyzeOrcamento(
  orc: any,
  config: AnalysisConfig,
  desl: DeslocamentoInput = DEFAULT_DESLOCAMENTO,
  extrasInput?: ExtrasInput,
  overrides: AnalysisOverrides = {}
): OrcamentoAnalysis {
  const produtos: AnalysisLine[] = (orc.produtos || [])
    .map((p: any) => p?.produto ?? p)
    .filter(Boolean)
    .map((p: any) => buildLine(p, 'produto'));

  const servicos: AnalysisLine[] = (orc.servicos || [])
    .map((s: any) => s?.servico ?? s)
    .filter(Boolean)
    .map((s: any) => buildLine(s, 'servico'));

  const linhas = [...produtos, ...servicos];

  const num = (v: number | undefined, fallback: number) => (typeof v === 'number' && isFinite(v) ? v : fallback);

  const receitaProdutos = num(overrides.receitaProdutos, produtos.reduce((s, l) => s + l.receita, 0));
  const receitaServicos = num(overrides.receitaServicos, servicos.reduce((s, l) => s + l.receita, 0));
  const receitaFrete = parseMoney(orc.valor_frete);
  const descontoCabecalho = num(overrides.descontoCabecalho, parseMoney(orc.desconto_valor));
  const receitaBruta = receitaProdutos + receitaServicos + receitaFrete;
  const valorTotalGC = parseMoney(orc.valor_total);
  const receitaAlterada =
    overrides.receitaProdutos !== undefined ||
    overrides.receitaServicos !== undefined ||
    overrides.descontoCabecalho !== undefined;
  const receitaLiquida =
    !receitaAlterada && valorTotalGC > 0 ? valorTotalGC : receitaBruta - descontoCabecalho;

  const custoProdutos = num(overrides.custoProdutos, produtos.reduce((s, l) => s + l.custo, 0));
  const custoServicos = num(overrides.custoServicos, servicos.reduce((s, l) => s + l.custo, 0));


  // --- Deslocamento --------------------------------------------------------
  const linhasDesl = linhas.filter((l) => l.isDeslocamento);
  const kmDetectado = linhasDesl.reduce((s, l) => s + l.quantidade, 0);
  const custoJaNasLinhas = linhasDesl.reduce((s, l) => s + l.custo, 0);
  const receitaDesl = linhasDesl.reduce((s, l) => s + l.receita, 0);
  const custoPorKm = desl.modo === 'manual' ? (desl.custoPorKm ?? config.custoPorKm) : config.custoPorKm;
  const kmConsiderado = desl.modo === 'ignorar' ? 0 : desl.modo === 'manual' ? desl.km : kmDetectado;
  const custoEstimado = desl.modo === 'ignorar' ? 0 : kmConsiderado * custoPorKm;
  // Evita contagem dupla: o custo já cadastrado nas linhas de deslocamento
  // continua dentro de custoServicos/custoProdutos; aqui somamos só a diferença.
  const custoAdicional = Math.max(0, custoEstimado - custoJaNasLinhas);

  const deslocamento: DeslocamentoResumo = {
    modo: desl.modo,
    kmDetectado,
    km: kmConsiderado,
    custoPorKm,
    custoEstimado,
    custoJaNasLinhas,
    custoAdicional,
    receita: receitaDesl,
    linhas: linhasDesl.map((l) => l.nome),
  };

  // Premiação: deslocamento, hospedagem e alimentação não entram na base
  const receitaBrutaProdutos = produtos.reduce((s, l) => s + l.receita, 0);
  const receitaBrutaServicos = servicos.reduce((s, l) => s + l.receita, 0);
  const premBrutaProdutos = produtos.filter(isLinhaPremiavel).reduce((s, l) => s + l.receita, 0);
  const premBrutaServicos = servicos.filter(isLinhaPremiavel).reduce((s, l) => s + l.receita, 0);
  const ratio = (base: number, total: number) => (total > 0 ? base / total : 1);
  const receitaPremiavelProdutos = receitaProdutos * ratio(premBrutaProdutos, receitaBrutaProdutos);
  const receitaPremiavelServicos = receitaServicos * ratio(premBrutaServicos, receitaBrutaServicos);

  const extrasIn = extrasInput ?? defaultExtras(config);
  const extras = computeExtras(config, extrasIn, receitaProdutos, receitaServicos, {
    nomeCliente: String(orc.nome_cliente || ''),
    receitaRestorno: receitaLiquida,
    receitaFinanciamento: receitaLiquida,
    basePremiacaoPecas: receitaPremiavelProdutos,
    basePremiacaoServicos: receitaPremiavelServicos,
  });

  const custoDeslocamento = desl.modo === 'ignorar' ? custoJaNasLinhas : Math.max(custoEstimado, custoJaNasLinhas);
  const custoTotal = custoProdutos + custoServicos + custoAdicional + extras.total;

  const nota10 = Boolean(extrasIn.nota10);
  const impostoPctEfetivo = nota10 ? Math.max(0, config.impostoPct - 10) : config.impostoPct;
  const imposto = receitaLiquida * (impostoPctEfetivo / 100);
  const custoFixo = receitaLiquida * (config.custoFixoPct / 100);
  const garantia = receitaLiquida * (config.garantiaPct / 100);
  const lucro = receitaLiquida - custoTotal - imposto - custoFixo - garantia;

  const descontoLinhas = linhas.reduce((s, l) => s + l.descontoAplicado, 0);
  const brutoSemDesconto = receitaBruta + descontoLinhas;

  // Desconto máximo mantendo margem alvo:
  // (R - D) - custoTotal - (R - D) * p = m * (R - D)  =>  R - D = custoTotal / (1 - p - m)
  const pTaxas = (impostoPctEfetivo + config.custoFixoPct + config.garantiaPct) / 100;
  const maxDesconto = (margemPct: number) => {
    const den = 1 - pTaxas - margemPct / 100;
    if (den <= 0) return 0;
    return Math.max(0, receitaLiquida - custoTotal / den);
  };
  const descontoMaxMinima = maxDesconto(config.margemMinima);
  const descontoMaxMeta = maxDesconto(config.margemMeta);




  return {
    id: String(orc.id),
    codigo: String(orc.codigo),
    nomeCliente: String(orc.nome_cliente || ''),
    equipamento: extractEquipamento(orc),
    nomeVendedor: orc.nome_vendedor ? String(orc.nome_vendedor) : undefined,
    data: String(orc.data || ''),
    nomeSituacao: String(orc.nome_situacao || ''),
    linhas,
    receitaProdutos,
    receitaServicos,
    receitaPremiavelProdutos,
    receitaPremiavelServicos,
    receitaFrete,
    descontoCabecalho,
    receitaBruta,
    receitaLiquida,
    custoProdutos,
    custoServicos,
    custoDeslocamento,
    deslocamento,
    custoTotal,
    extras,
    imposto,
    impostoPctEfetivo,
    nota10,
    custoFixo,
    garantia,
    lucro,
    margemLiquidaPct: receitaLiquida > 0 ? (lucro / receitaLiquida) * 100 : 0,
    margemBrutaPct: receitaLiquida > 0 ? ((receitaLiquida - custoTotal) / receitaLiquida) * 100 : 0,
    descontoTotalPct:
      brutoSemDesconto > 0 ? ((descontoLinhas + descontoCabecalho) / brutoSemDesconto) * 100 : 0,
    descontoMaxMinima,
    descontoMaxMinimaPct: receitaLiquida > 0 ? (descontoMaxMinima / receitaLiquida) * 100 : 0,
    descontoMaxMeta,
    descontoMaxMetaPct: receitaLiquida > 0 ? (descontoMaxMeta / receitaLiquida) * 100 : 0,
    linhasSemCusto: linhas.filter((l) => l.semCusto).length,
    valorTotalGC,
    config,
  };
}
