import { callGC } from '@/lib/gc-client';
import { conferirFinanceiroGC, buscarPagamentosGC } from './financeiroGC';
import { analisarFretes } from './fretes';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import type { Conferencia, DadosVenda, PagamentoComissao, Parametros } from './calculo';
import type { EventoSituacaoComissao, ResultadoSituacaoComissoes } from './situacao';

// Tabelas da migration 20260914160000, ainda não incluídas no arquivo gerado.
const db = supabase as unknown as SupabaseClient;
export async function carregarComissoes(inicio: string, fim: string, progresso?: (concluidos:number,total:number,etapa?:string)=>void) {
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
  let pagamentosFrete=fontes.filter(f=>f.tipo==='pagamento').map(f=>f.registro);
  let avisoFretes='';
  try {pagamentosFrete=await buscarPagamentosGC(callGC,(n,total)=>progresso?.(n,total,'páginas de pagamentos'));}
  catch {avisoFretes='Não foi possível concluir a consulta dos pagamentos no GC. Fretes exibidos pela última sincronização, sujeitos a títulos substituídos ou excluídos.';}
  const fretes=analisarFretes(fontes.filter(f=>f.tipo==='compra').map(f=>f.registro),pagamentosFrete);
  const rateios=fontes.filter(f=>f.tipo==='rateio').map(f=>f.registro);
  return { vendas: (await conferirFinanceiroGC(vendas,callGC,progresso)).map(v=>({...v,fretes,consultaFretes:avisoFretes?'pendente' as const:'gc' as const})), parametros, fretes, rateios, avisoFretes, origemConsulta:'gc' };
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
  const { error } = await db.from('fin_comissoes_config').update({ parametros }).eq('id', 'global');
  if (error) throw error;
}
