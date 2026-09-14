import { analyzeOrcamento, defaultExtras, DEFAULT_DESLOCAMENTO, parseMoney, type AnalysisConfig, type ExtrasInput, type DeslocamentoInput } from './analisePickPack';

export type Registro = Record<string, any>;
export interface Conferencia {
  venda_id: string;
  ajustes: { extras?: ExtrasInput; deslocamento?: DeslocamentoInput; custoAdicional?: number; vendedorNome?: string; justificativa?: string };
  conferido: boolean;
  assinatura?: string;
  updated_at?: string;
}
export interface PagamentoComissao { id: string; venda_id: string; valor: number; data_pagamento: string; forma_pagamento: string; observacao: string; created_at?: string; snapshot?: Registro }
export interface DadosVenda { consultaFinanceira?: 'gc'|'pendente'; venda: Registro; recebimentos: Registro[]; conferencia: Conferencia | null; pagamentos: PagamentoComissao[] }
export interface Parametros { config: AnalysisConfig; margemAposComissao: boolean; origem: string }

export function faixaComissao(margem: number | null): number {
  if (margem === null || !Number.isFinite(margem)) return 0;
  return margem > 20 ? 5 : margem >= 12 ? 3 : 0;
}
export const centavos = (valor: number) => Math.round((valor + Number.EPSILON) * 100) / 100;

function canonico(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonico).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonico(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
export function assinaturaVenda(dados: DadosVenda, parametros: Parametros) {
  const raw=dados.venda.gc_payload_raw??{};
  return canonico({total:dados.venda.valor_total,situacao:dados.venda.nome_situacao,produtos:raw.produtos,servicos:raw.servicos,frete:raw.valor_frete,desconto:raw.desconto_valor,vendedor:raw.nome_vendedor,parcelas:raw.numero_parcelas,pagamentos:raw.pagamentos,parametros,ajustes:dados.conferencia?.ajustes??{},taxas:dados.recebimentos.map(r=>[r.gc_id,r.gc_payload_raw?.taxa_banco,r.gc_payload_raw?.taxa_operadora]).sort()});
}

export function calcularVenda(dados: DadosVenda, parametros: Parametros) {
  const v = dados.venda;
  const raw = v.gc_payload_raw ?? {};
  const ajustes = dados.conferencia?.ajustes ?? {};
  const extras: ExtrasInput = ajustes.extras ?? { ...defaultExtras(parametros.config), parcelas: Math.max(1, parseMoney(raw.numero_parcelas) || raw.pagamentos?.length || 1) };
  const a = analyzeOrcamento({ ...raw, id: v.gc_id, codigo: v.codigo, nome_cliente: v.nome_cliente, valor_total: v.valor_total }, parametros.config, ajustes.deslocamento ?? DEFAULT_DESLOCAMENTO, extras);
  const avisos: string[] = [];
  const vendedorOriginal = String(raw.nome_vendedor ?? '').trim();
  const vendedor = ajustes.vendedorNome?.trim() || vendedorOriginal;
  if (!vendedor || /\bAPI\b/i.test(vendedor)) avisos.push('Identificar o vendedor responsável');
  if (!a.linhas.length) avisos.push('Itens da venda não sincronizados');
  if (a.linhasSemCusto) avisos.push(`${a.linhasSemCusto} item(ns) sem custo — conferir antes de calcular`);
  const itensInvalidos = a.linhas.some(l => l.quantidade <= 0 || l.valorUnitCusto < 0 || l.receita < 0);
  if (itensInvalidos) avisos.push('Quantidade ou valor inválido nos itens');
  if (!Number.isFinite(a.receitaLiquida) || a.receitaLiquida <= 0) avisos.push('Valor de venda inválido');
  const cancelada = /cancel|devol|estorn|uso interno/i.test(String(v.nome_situacao ?? raw.nome_situacao ?? ''));
  const concretizada = /concretiz|faturad|finaliz/i.test(String(v.nome_situacao ?? raw.nome_situacao ?? ''));
  if (cancelada) avisos.push('Venda cancelada, devolvida ou de uso interno: sem comissão');
  else if (!concretizada) avisos.push('Venda ainda não concretizada');

  // Rateia o desconto do cabeçalho; serviços e frete nunca integram a base.
  const fatorDesconto = a.receitaBruta > 0 ? Math.min(1, a.receitaLiquida / a.receitaBruta) : 0;
  const base = centavos(Math.max(0, a.receitaProdutos * fatorDesconto));
  const custoAdicional = Math.max(0, Number(ajustes.custoAdicional) || 0);
  const taxasRecebimento = dados.recebimentos.reduce((s, r) => s + parseMoney(r.gc_payload_raw?.taxa_banco) + parseMoney(r.gc_payload_raw?.taxa_operadora), 0);
  const lucroAntes = centavos(a.lucro - custoAdicional - taxasRecebimento);
  const margemAntes = a.receitaLiquida > 0 ? lucroAntes / a.receitaLiquida * 100 : null;
  const custosValidos = a.linhas.length > 0 && a.linhasSemCusto === 0 && !itensInvalidos && margemAntes !== null;
  let percentual = custosValidos && !cancelada && concretizada ? faixaComissao(margemAntes) : 0;
  if (parametros.margemAposComissao && percentual) {
    const margemCom = (pct: number) => (lucroAntes - centavos(base * pct / 100)) / a.receitaLiquida * 100;
    percentual = margemCom(5) > 20 ? 5 : margemCom(3) >= 12 ? 3 : 0;
  }
  const comissao = centavos(base * percentual / 100);
  const margemFinal = a.receitaLiquida > 0 ? (lucroAntes - comissao) / a.receitaLiquida * 100 : null;
  if (custosValidos && concretizada && !cancelada && !percentual) avisos.push('Margem abaixo de 12%: sem comissão');

  const titulos = dados.recebimentos;
  const recebido = centavos(titulos.filter(r => r.liquidado === true).reduce((s, r) => s + parseMoney(r.valor_total ?? r.valor), 0));
  const totalTitulos = centavos(titulos.reduce((s, r) => s + parseMoney(r.valor_total ?? r.valor), 0));
  const todosLiquidados = titulos.length > 0 && titulos.every(r => r.liquidado === true);
  const financeiroCompleto = titulos.length > 0 && Math.abs(totalTitulos - a.receitaLiquida) <= 0.02;
  const recebimento = !titulos.length ? (dados.consultaFinanceira==='gc'?'Títulos não localizados no GC':'Financeiro pendente de consulta') : !financeiroCompleto ? 'Conferir valores do financeiro' : todosLiquidados ? 'Recebido' : recebido > 0 ? 'Parcial' : 'Em aberto';
  if (!financeiroCompleto) avisos.push(recebimento);
  if(dados.consultaFinanceira==='pendente') avisos.push('Não foi possível atualizar o financeiro no GC; última leitura preservada');
  const parcelas = (raw.pagamentos ?? []).map((p: Registro) => p.pagamento ?? p);
  const formas = [...new Set<string>([raw.nome_forma_pagamento, ...parcelas.map((p: Registro) => p.nome_forma_pagamento), ...titulos.map(r => r.nome_forma_pagamento)].filter(Boolean))];
  const semForma = (r: Registro) => (!r.forma_pagamento_id && !r.nome_forma_pagamento) || /a combinar|a definir|n[aã]o informad|indefinid/i.test(String(r.nome_forma_pagamento??''));
  const formaAusente = titulos.length ? titulos.some(semForma) : parcelas.length ? parcelas.some(semForma) : semForma(raw);
  if (formaAusente) avisos.push('Forma de pagamento ausente em uma ou mais parcelas');
  const pago = centavos(dados.pagamentos.reduce((s, p) => s + Number(p.valor), 0));
  const conferidaAtual = !!dados.conferencia?.conferido && dados.conferencia.assinatura === assinaturaVenda(dados,parametros);
  if (dados.conferencia?.conferido && !conferidaAtual) avisos.push('Valores ou parâmetros mudaram: conferir novamente');
  if (pago > comissao) avisos.push('Comissão paga maior que a previsão atual');
  return { ...dados, a, extras, vendedor, vendedorOriginal, base, custoAdicional, taxasRecebimento, lucroAntes, margemAntes: custosValidos ? margemAntes : null, margemFinal: custosValidos ? margemFinal : null, percentual, comissao, recebido, totalTitulos, recebimento, formas, formaAusente, avisos, pago, saldo: centavos(comissao - pago), custosValidos, cancelada, concretizada, conferidaAtual };
}

export function periodoComissao(mes: string, tipo: 'mes' | 'primeira' | 'segunda') {
  const [ano, m] = mes.split('-').map(Number);
  const ultimo = new Date(ano, m, 0).getDate();
  return { inicio: `${mes}-${tipo === 'segunda' ? '16' : '01'}`, fim: `${mes}-${tipo === 'primeira' ? '15' : ultimo}` };
}
