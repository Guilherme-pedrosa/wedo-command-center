import { callGC } from '@/lib/gc-client';
import { conferirFinanceiroGC, buscarPagamentosGC } from './financeiroGC';
import { analisarFretes } from './fretes';
import { tabelaValida } from './taxasRecebimento';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import type { Conferencia, DadosVenda, OrigemConsulta, PagamentoComissao, Parametros } from './calculo';
import type { PedidoCompraComissao } from './pedidoCompraGC';
import type { EventoSituacaoComissao, ResultadoSituacaoComissoes } from './situacao';

// Tabelas da migration 20260914160000, ainda não incluídas no arquivo gerado.
const db = supabase as unknown as SupabaseClient;
export interface OpcoesCarga {
  /**
   * true: conferir recebimentos e pagamentos ao vivo no GC (145+ paginas de
   * /api/pagamentos e uma consulta por cliente -- minutos). false: usar o
   * espelho local, que o sync-all atualiza a cada 30 min -- segundos.
   */
  aoVivo?: boolean;
}

/** Quando cada colecao foi sincronizada do GC pela ultima vez, para a tela dizer a idade do dado. */
export async function ultimaSincronizacaoGC(): Promise<{ recebimentos: string | null; pagamentos: string | null }> {
  const ler = async (tipo: string) => {
    const { data } = await db.from('fin_sync_log').select('created_at').eq('tipo', tipo).eq('status', 'success').order('created_at', { ascending: false }).limit(1).maybeSingle();
    return (data?.created_at as string | undefined) ?? null;
  };
  const [recebimentos, pagamentos] = await Promise.all([ler('gc_import_recebimentos'), ler('gc_import_pagamentos')]);
  return { recebimentos, pagamentos };
}

export async function carregarComissoes(inicio: string, fim: string, progresso?: (concluidos:number,total:number,etapa?:string)=>void, opcoes: OpcoesCarga = {}) {
  if (!inicio || !fim || inicio > fim || (Date.parse(fim) - Date.parse(inicio)) / 86400000 > 366) throw new Error('Escolha um período válido de até 366 dias.');
  const config = await db.from('fin_comissoes_config').select('parametros').eq('id', 'global').single();
  if (config.error) throw config.error;
  const parametros = config.data.parametros as Parametros;
  if (!parametros?.config || Object.values(parametros.config).some(x => typeof x !== 'number' || !Number.isFinite(x) || x < 0)) throw new Error('Parâmetros de custo inválidos. Confira as configurações.');
  const vendas: DadosVenda[] = [];
  for (let offset = 0; ; offset += 200) {
    const { data, error } = await db.rpc('fin_comissoes_dados', { inicio, fim }).range(offset, offset + 199);
    if (error) throw error;
    vendas.push(...(data as DadosVenda[]));
    if (data.length < 200) break;
  }
  const fontes: { tipo:string; registro:Record<string,any> }[]=[];
  for(let offset=0;;offset+=200) {
    const {data,error}=await db.rpc('fin_comissoes_fontes_frete').range(offset,offset+199);
    if(error)throw error;
    fontes.push(...data);if(data.length<200)break;
  }
  // Por padrao tudo vem do espelho local. Ir ao GC a cada carga da pagina
  // custava minutos (145 paginas de pagamentos + uma consulta por cliente),
  // e cada F5 repetia -- alem de ser uma das fontes de 429 no GC.
  let pagamentosFrete=fontes.filter(f=>f.tipo==='pagamento').map(f=>f.registro);
  let avisoFretes='';
  let origemFretes: OrigemConsulta = 'sync';
  if (opcoes.aoVivo) {
    try {pagamentosFrete=await buscarPagamentosGC(callGC,(n,total)=>progresso?.(n,total,'páginas de pagamentos'));origemFretes='gc';}
    catch {avisoFretes='Não foi possível concluir a consulta dos pagamentos no GC. Fretes exibidos pela última sincronização, sujeitos a títulos substituídos ou excluídos.';origemFretes='pendente';}
  }
  const fretes=analisarFretes(fontes.filter(f=>f.tipo==='compra').map(f=>f.registro),pagamentosFrete);
  const rateios=fontes.filter(f=>f.tipo==='rateio').map(f=>f.registro);
  const vendasConferidas = opcoes.aoVivo
    ? await conferirFinanceiroGC(vendas,callGC,progresso)
    : vendas.map(v=>({...v,consultaFinanceira:'sync' as const}));
  const sincronizadoEm = await ultimaSincronizacaoGC();
  return { vendas: vendasConferidas.map(v=>({...v,fretes,consultaFretes:origemFretes})), parametros, fretes, rateios, avisoFretes, origemConsulta: opcoes.aoVivo ? 'gc' as const : 'sync' as const, sincronizadoEm };
}
export async function salvarConferencia(value: Conferencia) {
  // A situação usa uma RPC própria. Não reenviar esses campos de uma tela
  // desatualizada evita substituir uma retirada feita por outro administrador.
  const { venda_id, ajustes, conferido, assinatura } = value;
  const { error } = await db.from('fin_comissoes_conferencias').upsert({ venda_id, ajustes, conferido, assinatura });
  if (error) throw error;
}
export async function alterarSituacaoComissoes(ids: string[], retirada: boolean, motivo: string): Promise<ResultadoSituacaoComissoes> {
  const vendaIds = [...new Set(ids)];
  const justificativa = motivo.trim();
  if (!vendaIds.length || vendaIds.length > 200 || vendaIds.some(id => !id)) throw new Error('Selecione entre 1 e 200 vendas por operação.');
  if (!justificativa || justificativa.length > 2000) throw new Error('Informe o motivo com até 2.000 caracteres.');
  const { data, error } = await db.rpc('fin_comissoes_alterar_situacao', {
    p_venda_ids: vendaIds, p_retirada: retirada, p_motivo: justificativa,
  });
  if (error) throw error;
  return data as ResultadoSituacaoComissoes;
}
export async function carregarHistoricoComissao(vendaId: string): Promise<EventoSituacaoComissao[]> {
  const historico: EventoSituacaoComissao[] = [];
  for (let offset = 0; ; offset += 200) {
    const { data, error } = await db.from('fin_comissoes_situacao_eventos').select('*')
      .eq('venda_id', vendaId).order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 199);
    if (error) throw error;
    historico.push(...data as EventoSituacaoComissao[]);
    if (data.length < 200) return historico;
  }
}
export async function carregarConferenciasComissoes(vendaIds: string[]): Promise<Conferencia[]> {
  const ids = [...new Set(vendaIds)];
  if (!ids.length) return [];
  if (ids.length > 500) throw new Error('Consulte até 500 conferências por operação.');
  const { data, error } = await db.from('fin_comissoes_conferencias').select('*').in('venda_id', ids);
  if (error) throw error;
  return data as Conferencia[];
}
export async function registrarPagamento(value: Omit<PagamentoComissao, 'created_at'>) {
  if (!Number.isFinite(value.valor) || value.valor <= 0 || !value.data_pagamento || !value.forma_pagamento.trim()) throw new Error('Informe valor, data e forma do pagamento da comissão.');
  const { error } = await db.from('fin_comissoes_pagamentos').insert(value);
  if (error) throw error;
}
export async function salvarParametros(parametros: Parametros) {
  if (Object.values(parametros.config).some(x => !Number.isFinite(x) || x < 0)) throw new Error('Os parâmetros devem ser números válidos e não negativos.');
  if (parametros.tabelaTaxas !== undefined && tabelaValida(parametros.tabelaTaxas) !== parametros.tabelaTaxas) throw new Error('Tabela de taxas inválida: cada linha precisa de forma, percentual entre 0 e 100 e valor fixo não negativo.');
  const { error } = await db.from('fin_comissoes_config').update({ parametros }).eq('id', 'global');
  if (error) throw error;
}

// ─── Pedido de compra no GC ───────────────────────────────────────────────

export interface PedidoGCRegistro {
  id: string;
  vendedor_chave: string;
  vendedor_nome: string;
  fornecedor_gc_id: string;
  periodo_inicio: string;
  periodo_fim: string;
  valor_total: number;
  vendas: { vendaId: string; codigo: string; comissao: number }[];
  status: 'pendente' | 'enviado' | 'erro' | 'cancelado';
  gc_compra_id: string | null;
  gc_codigo: string | null;
  erro: string | null;
  created_at: string;
}

/** Pedidos já gerados, mais recentes primeiro. A tela usa para saber o que já foi pedido. */
export async function listarPedidosGC(): Promise<PedidoGCRegistro[]> {
  const { data, error } = await db.from('fin_comissoes_pedidos_gc').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  return (data ?? []) as PedidoGCRegistro[];
}

/** Ids das vendas que já estão em algum pedido não cancelado. */
export function vendasJaPedidas(pedidos: PedidoGCRegistro[]): Set<string> {
  const s = new Set<string>();
  for (const p of pedidos) {
    if (p.status === 'cancelado') continue;
    for (const v of p.vendas ?? []) s.add(String(v.vendaId));
  }
  return s;
}

/**
 * Grava o pedido e enfileira o POST para o GC.
 *
 * Duas escritas, nesta ordem: primeiro o pedido (a unicidade por vendedor e
 * período barra a duplicata antes de qualquer job existir), depois o job em
 * fin_gc_write_jobs, que o cron process-gc-write-jobs executa com lock e
 * retry. O processador grava de volta o id e o código do GC. Nada aqui
 * chama o GC diretamente — quem falha no meio deixa o pedido em "pendente"
 * sem job, e a tela oferece reenfileirar.
 */
export async function gerarPedidoCompraGC(pedido: PedidoCompraComissao): Promise<PedidoGCRegistro> {
  const { data: linha, error } = await db
    .from('fin_comissoes_pedidos_gc')
    .insert({
      vendedor_chave: pedido.vendedorChave,
      vendedor_nome: pedido.vendedorNome,
      fornecedor_gc_id: pedido.fornecedorId,
      periodo_inicio: pedido.periodoInicio,
      periodo_fim: pedido.periodoFim,
      valor_total: pedido.valorTotal,
      vendas: pedido.vendas,
      payload: pedido.payload,
      status: 'pendente',
    })
    .select('*')
    .single();
  if (error) {
    if (String(error.code) === '23505') throw new Error(`Já existe pedido de ${pedido.vendedorNome} para o período ${pedido.periodoInicio} a ${pedido.periodoFim}.`);
    throw error;
  }

  const { data: job, error: erroJob } = await db
    .from('fin_gc_write_jobs')
    .insert({
      recurso: 'compras',
      recurso_id: String(linha.id),
      payload: pedido.payload,
      payload_hash: btoa(`comissao-v1|${linha.id}`),
      status: 'pendente',
    })
    .select('id')
    .single();
  if (erroJob) throw new Error(`Pedido gravado, mas o envio ao GC não foi enfileirado: ${erroJob.message}`);

  await db.from('fin_comissoes_pedidos_gc').update({ job_id: job.id }).eq('id', linha.id);
  return { ...(linha as PedidoGCRegistro), status: 'pendente' };
}
