// src/hooks/useRaioXAnual.ts — dados do Raio-X anual (DRE gerencial + caixa).
//
// Duas lições caras (03/09/2026):
// 1. Paginar SEM `order` perde e repete linhas entre páginas — a página chegou a mostrar
//    R$ 140 mil a menos de pagamentos. Toda leitura paginada ordena por id e confere a
//    contagem exata; se divergir, falha alto em vez de mostrar número furado.
// 2. Disparar 8 chamadas paralelas à edge de Premiação estoura timeout em todas, e o
//    catch silencioso virava "comissões = R$ 0". Agora é sequencial, em query separada,
//    com fallback explícito (comissões pagas no mês seguinte) e sinalizado na tela.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  construirRaioX, osSemTitulo, mesesDoAno,
  type OsRow, type PagamentoRow, type VendaRow, type PcmRow, type RecebimentoTituloRow,
} from '@/lib/raioXAnual';

const PAGE = 1000;
const PLANO_COMISSOES = 'e7299b90-98d2-4d7a-a04c-78ba40cc847a';

type PageResult<T> = { data: T[] | null; error: { message?: string } | null; count?: number | null };

// Lê todas as páginas de uma consulta. O builder DEVE aplicar `.order('id')` antes do range.
async function todas<T>(nome: string, build: (from: number, to: number, comContagem: boolean) => PromiseLike<PageResult<T>>): Promise<T[]> {
  const rows: T[] = [];
  let esperado: number | null = null;
  for (let from = 0; ; from += PAGE) {
    const { data, error, count } = await build(from, from + PAGE - 1, from === 0);
    if (error) throw new Error(`${nome}: ${error.message || 'falha ao carregar'}`);
    if (from === 0 && typeof count === 'number') esperado = count;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  if (esperado !== null && esperado !== rows.length) {
    throw new Error(`${nome}: leitura inconsistente (${rows.length} de ${esperado} linhas) — recarregue a página`);
  }
  return rows;
}

const proximoMes = (m: string) => {
  const [y, mm] = m.split('-').map(Number);
  return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
};

function periodo(ano: number) {
  const hoje = new Date();
  // Mês fechado: no ano corrente, o mês anterior ao atual; em anos passados, dezembro.
  const ateMesFechado = ano < hoje.getFullYear() ? 12 : Math.max(1, hoje.getMonth());
  const ultimoDia = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}-${new Date(y, m, 0).getDate()}`;
  return {
    ateMesFechado,
    inicio: `${ano}-01-01`,
    fimFechado: ultimoDia(ano, ateMesFechado),
    fimComRef: ateMesFechado === 12 ? ultimoDia(ano + 1, 1) : ultimoDia(ano, ateMesFechado + 1),
  };
}

type Dados = {
  ateMesFechado: number; inicio: string;
  os: OsRow[]; pagamentos: PagamentoRow[]; vendas: VendaRow[]; pcm: PcmRow[];
  titulos: RecebimentoTituloRow[];
  recebidosPorMes: Record<string, number>; pagosPorMes: Record<string, number>;
  comissoesPagasM1: Record<string, number>; // comissões pagas no mês seguinte (fallback)
};

async function carregarDados(ano: number): Promise<Dados> {
  const { ateMesFechado, inicio, fimFechado, fimComRef } = periodo(ano);
  // O select precisa receber as colunas como literal (não variável) para o supabase-js tipar as linhas.
  const contagem = (c: boolean) => (c ? { count: 'exact' as const } : undefined);

  const [os, metasPlanos, pagamentosRaw, vendasRaw, internasRaw, pcm, titulos] = await Promise.all([
    todas<OsRow>('os_index', (f, t, c) => supabase.from('os_index')
      .select('os_codigo, nome_cliente, nome_situacao, valor_total, valor_pecas, valor_pecas_custo, data_saida', contagem(c))
      .gte('data_saida', inicio).lte('data_saida', fimFechado).order('id').range(f, t)),
    Promise.all([
      supabase.from('fin_meta_plano_contas').select('plano_contas_id, meta_id'),
      supabase.from('fin_metas').select('id, nome, categoria').eq('ativo', true),
      supabase.from('fin_plano_contas').select('id, nome'),
    ]).then(([mp, m, pc]) => {
      if (mp.error) throw mp.error; if (m.error) throw m.error; if (pc.error) throw pc.error;
      const metas = new Map((m.data || []).map((x: any) => [x.id, x]));
      const map = new Map<string, { categoria: 'custo_fixo' | 'custo_variavel' | null; nome: string }>();
      for (const l of mp.data || []) {
        const meta: any = metas.get((l as any).meta_id);
        if (meta && meta.categoria !== 'receita') map.set(String((l as any).plano_contas_id), { categoria: meta.categoria, nome: meta.nome });
      }
      const nomesPlanos = new Map<string, string>((pc.data || []).map((x: any) => [String(x.id), String(x.nome || '')]));
      return { map, nomesPlanos };
    }),
    todas<any>('fin_pagamentos', (f, t, c) => supabase.from('fin_pagamentos')
      .select('plano_contas_id, valor, data_vencimento, descricao, nome_fornecedor', contagem(c))
      .neq('status', 'cancelado')
      .gte('data_vencimento', inicio).lte('data_vencimento', fimComRef).order('id').range(f, t)),
    todas<any>('gc_vendas', (f, t, c) => supabase.from('gc_vendas')
      .select('valor_total, gc_payload_raw, data', contagem(c))
      .eq('situacao_id', '7063585')
      .gte('data', inicio).lte('data', fimFechado).order('id').range(f, t)),
    todas<any>('gc_vendas (uso interno)', (f, t, c) => supabase.from('gc_vendas')
      .select('gc_payload_raw, data', contagem(c))
      .eq('situacao_id', '7340612')
      .gte('data', inicio).lte('data', fimFechado).order('id').range(f, t)),
    todas<PcmRow>('gc_recebimentos (PCM)', (f, t, c) => supabase.from('gc_recebimentos')
      .select('valor, data_vencimento', contagem(c))
      .in('plano_contas_id', ['27867721', '27867722']).eq('liquidado', true)
      .gte('data_vencimento', inicio).lte('data_vencimento', fimFechado).order('id').range(f, t)),
    // Títulos desde o ano anterior: cobrem OS do ano (vínculo por nº), liquidações e abertos.
    todas<RecebimentoTituloRow>('gc_recebimentos', (f, t, c) => supabase.from('gc_recebimentos')
      .select('os_codigo, descricao, valor, liquidado, data_liquidacao, data_vencimento', contagem(c))
      .gte('data_vencimento', `${ano - 1}-01-01`).order('id').range(f, t)),
  ]);

  const custoDe = (raw: any) => parseFloat(String(raw?.valor_custo || '0').replace(',', '.')) || 0;
  const vendas: VendaRow[] = [
    ...vendasRaw.map((v: any) => ({ valor_total: v.valor_total, custo: custoDe(v.gc_payload_raw), data: v.data, interna: false })),
    ...internasRaw.map((v: any) => ({ valor_total: 0, custo: custoDe(v.gc_payload_raw), data: v.data, interna: true })),
  ];
  const pagamentos: PagamentoRow[] = pagamentosRaw.map((p: any) => {
    const meta = metasPlanos.map.get(String(p.plano_contas_id));
    return {
      ...p,
      categoria_meta: meta?.categoria ?? null,
      nome_meta: meta?.nome ?? null,
      nome_plano: metasPlanos.nomesPlanos.get(String(p.plano_contas_id)) ?? null,
    };
  });

  const meses = mesesDoAno(ano, ateMesFechado);
  const monthStr = (d: string | null) => (d ? String(d).slice(0, 7) : '');
  const recebidosPorMes: Record<string, number> = {};
  for (const r of titulos) {
    if (!r.liquidado) continue;
    const m = monthStr(r.data_liquidacao || r.data_vencimento);
    if (meses.includes(m)) recebidosPorMes[m] = (recebidosPorMes[m] || 0) + (r.valor || 0);
  }
  const pagosPorMes: Record<string, number> = {};
  const comissoesPagasM1: Record<string, number> = {};
  for (const p of pagamentosRaw) {
    const m = monthStr(p.data_vencimento);
    if (meses.includes(m)) pagosPorMes[m] = (pagosPorMes[m] || 0) + Math.abs(p.valor || 0);
    if (String(p.plano_contas_id) === PLANO_COMISSOES) {
      // comissão do mês M é paga em M+1 — atribui ao mês de referência
      const ref = meses.find(x => proximoMes(x) === m);
      if (ref) comissoesPagasM1[ref] = (comissoesPagasM1[ref] || 0) + Math.abs(p.valor || 0);
    }
  }

  return { ateMesFechado, inicio, os, pagamentos, vendas, pcm, titulos, recebidosPorMes, pagosPorMes, comissoesPagasM1 };
}

// Comissões oficiais (tela de Premiação), um mês por vez: a edge é pesada e em paralelo
// estoura timeout. Um mês que falhar cai no fallback, sinalizado na tela.
async function carregarComissoes(ano: number): Promise<{ porMes: Record<string, number>; falhas: string[] }> {
  const { ateMesFechado } = periodo(ano);
  const porMes: Record<string, number> = {};
  const falhas: string[] = [];
  for (const m of mesesDoAno(ano, ateMesFechado)) {
    try {
      const resultado = await Promise.race([
        supabase.functions.invoke('premiacao-comissoes-total', { body: { month: m } }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 25_000)),
      ]);
      const { data, error } = resultado as { data: any; error: any };
      if (error || !data || data.ok === false || typeof data.comissao_final !== 'number') throw new Error('sem dado');
      porMes[m] = data.comissao_final;
    } catch {
      falhas.push(m);
    }
  }
  return { porMes, falhas };
}

export function useRaioXAnual(ano: number) {
  const { ateMesFechado } = periodo(ano);
  const dados = useQuery({ queryKey: ['raio-x-dados', ano, ateMesFechado], queryFn: () => carregarDados(ano), staleTime: 10 * 60 * 1000 });
  const comissoes = useQuery({ queryKey: ['raio-x-comissoes', ano, ateMesFechado], queryFn: () => carregarComissoes(ano), staleTime: 30 * 60 * 1000, retry: 1 });

  const data = useMemo(() => {
    const d = dados.data;
    if (!d) return undefined;
    const meses = mesesDoAno(ano, d.ateMesFechado);
    const oficiais = comissoes.data?.porMes || {};
    const comissoesPorMes: Record<string, number> = {};
    const mesesFallback: string[] = [];
    for (const m of meses) {
      if (typeof oficiais[m] === 'number') comissoesPorMes[m] = oficiais[m];
      else { comissoesPorMes[m] = d.comissoesPagasM1[m] || 0; mesesFallback.push(m); }
    }
    const modelo = construirRaioX({
      ano, ateMesFechado: d.ateMesFechado, os: d.os, pagamentos: d.pagamentos, vendas: d.vendas, pcm: d.pcm,
      comissoesPorMes, recebidosPorMes: d.recebidosPorMes, pagosPorMes: d.pagosPorMes,
    });
    const semTitulo = osSemTitulo(d.os, d.titulos);
    const emAberto = d.titulos.filter(t => !t.liquidado && (t.data_vencimento || '') >= d.inicio);
    const titulosAbertoTotal = emAberto.reduce((a, t) => a + (t.valor || 0), 0);
    const recebidoYtd = Object.values(d.recebidosPorMes).reduce((a, v) => a + v, 0);
    // Ponte: receita executada no período − recebido no período = ainda não recebido;
    // desse valor, o que não está em título aberto foi executado e nunca faturado.
    const naoRecebido = Math.max(0, modelo.ytd.recTot - recebidoYtd);
    return {
      ...modelo,
      semTitulo,
      semTituloTotal: semTitulo.reduce((a, o) => a + (o.valor_total || 0), 0),
      titulosAbertoTotal,
      titulosAbertoQtd: emAberto.length,
      naoRecebido,
      naoFaturadoEstimado: Math.max(0, naoRecebido - titulosAbertoTotal),
      comissoesCarregando: comissoes.isLoading,
      comissoesFallback: mesesFallback,
      totais: {
        pagos: Object.values(d.pagosPorMes).reduce((a, v) => a + v, 0),
        recebidos: recebidoYtd,
        linhasPagamentos: d.pagamentos.length,
        linhasOs: d.os.length,
      },
    };
  }, [ano, dados.data, comissoes.data, comissoes.isLoading]);

  return {
    data,
    isLoading: dados.isLoading,
    isFetching: dados.isFetching || comissoes.isFetching,
    error: dados.error,
    refetch: () => { dados.refetch(); comissoes.refetch(); },
  };
}
