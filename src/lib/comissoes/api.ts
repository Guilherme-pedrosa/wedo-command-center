import { callGC } from '@/lib/gc-client';
import { conferirFinanceiroGC } from './financeiroGC';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import type { Conferencia, DadosVenda, PagamentoComissao, Parametros } from './calculo';

// Tabelas da migration 20260914160000, ainda não incluídas no arquivo gerado.
const db = supabase as unknown as SupabaseClient;
export async function carregarComissoes(inicio: string, fim: string, progresso?: (concluidos:number,total:number)=>void) {
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
  return { vendas: await conferirFinanceiroGC(vendas,callGC,progresso), parametros };
}
export async function salvarConferencia(value: Conferencia) {
  const { error } = await db.from('fin_comissoes_conferencias').upsert(value);
  if (error) throw error;
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
