// src/hooks/useRaioXAnual.ts — dados do Raio-X anual (DRE gerencial + caixa).
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  construirRaioX, osSemTitulo, mesesDoAno,
  type OsRow, type PagamentoRow, type VendaRow, type PcmRow, type RecebimentoTituloRow,
} from '@/lib/raioXAnual';

const PAGE = 1000;
async function todas<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message?: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await fetchPage(from, from + PAGE - 1);
    if (error) throw new Error(error.message || 'Falha ao carregar dados do Raio-X');
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

export function useRaioXAnual(ano: number) {
  const hoje = new Date();
  // Mês fechado: no ano corrente, o mês anterior ao atual; em anos passados, dezembro.
  const ateMesFechado = ano < hoje.getFullYear() ? 12 : Math.max(1, hoje.getMonth());
  const inicio = `${ano}-01-01`;
  const fimFechado = `${ano}-${String(ateMesFechado).padStart(2, '0')}-31`;
  const fimComRef = ateMesFechado === 12 ? `${ano + 1}-01-31` : `${ano}-${String(ateMesFechado + 1).padStart(2, '0')}-31`;

  return useQuery({
    queryKey: ['raio-x-anual', ano, ateMesFechado],
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const [os, metasPlanos, pagamentosRaw, vendasRaw, internasRaw, pcm, titulos, recebidosLiq] = await Promise.all([
        todas<OsRow>((f, t) => supabase.from('os_index')
          .select('os_codigo, nome_cliente, nome_situacao, valor_total, valor_pecas_custo, data_saida')
          .gte('data_saida', inicio).lte('data_saida', fimFechado).range(f, t)),
        Promise.all([
          supabase.from('fin_meta_plano_contas').select('plano_contas_id, meta_id'),
          supabase.from('fin_metas').select('id, nome, categoria').eq('ativo', true),
        ]).then(([mp, m]) => {
          if (mp.error) throw mp.error; if (m.error) throw m.error;
          const metas = new Map((m.data || []).map((x: any) => [x.id, x]));
          const map = new Map<string, { categoria: 'custo_fixo' | 'custo_variavel' | null; nome: string }>();
          for (const l of mp.data || []) {
            const meta: any = metas.get((l as any).meta_id);
            if (meta && meta.categoria !== 'receita') map.set(String((l as any).plano_contas_id), { categoria: meta.categoria, nome: meta.nome });
          }
          return map;
        }),
        todas<any>((f, t) => supabase.from('fin_pagamentos')
          .select('plano_contas_id, valor, data_vencimento, descricao, nome_fornecedor')
          .neq('status', 'cancelado')
          .gte('data_vencimento', inicio).lte('data_vencimento', fimComRef).range(f, t)),
        todas<any>((f, t) => supabase.from('gc_vendas')
          .select('valor_total, gc_payload_raw, data')
          .eq('situacao_id', '7063585')
          .gte('data', inicio).lte('data', fimFechado).range(f, t)),
        todas<any>((f, t) => supabase.from('gc_vendas')
          .select('gc_payload_raw, data')
          .eq('situacao_id', '7340612')
          .gte('data', inicio).lte('data', fimFechado).range(f, t)),
        todas<PcmRow>((f, t) => supabase.from('gc_recebimentos')
          .select('valor, data_vencimento')
          .in('plano_contas_id', ['27867721', '27867722']).eq('liquidado', true)
          .gte('data_vencimento', inicio).lte('data_vencimento', fimFechado).range(f, t)),
        todas<RecebimentoTituloRow>((f, t) => supabase.from('gc_recebimentos')
          .select('os_codigo, descricao, valor, liquidado, data_liquidacao, data_vencimento')
          .range(f, t)),
        todas<any>((f, t) => supabase.from('gc_recebimentos')
          .select('valor, data_liquidacao, data_vencimento')
          .eq('liquidado', true).range(f, t)),
      ]);

      const custoDe = (raw: any) => parseFloat(String(raw?.valor_custo || '0').replace(',', '.')) || 0;
      const vendas: VendaRow[] = [
        ...vendasRaw.map((v: any) => ({ valor_total: v.valor_total, custo: custoDe(v.gc_payload_raw), data: v.data, interna: false })),
        ...internasRaw.map((v: any) => ({ valor_total: 0, custo: custoDe(v.gc_payload_raw), data: v.data, interna: true })),
      ];
      const pagamentos: PagamentoRow[] = pagamentosRaw.map((p: any) => {
        const meta = metasPlanos.get(String(p.plano_contas_id));
        return { ...p, categoria_meta: meta?.categoria ?? null, nome_meta: meta?.nome ?? null };
      });

      const meses = mesesDoAno(ano, ateMesFechado);
      const monthStr = (d: string | null) => (d ? String(d).slice(0, 7) : '');
      const recebidosPorMes: Record<string, number> = {};
      for (const r of recebidosLiq) {
        const m = monthStr(r.data_liquidacao || r.data_vencimento);
        if (meses.includes(m)) recebidosPorMes[m] = (recebidosPorMes[m] || 0) + (r.valor || 0);
      }
      const pagosPorMes: Record<string, number> = {};
      for (const p of pagamentosRaw) {
        const m = monthStr(p.data_vencimento);
        if (meses.includes(m)) pagosPorMes[m] = (pagosPorMes[m] || 0) + Math.abs(p.valor || 0);
      }

      const comissoesPares = await Promise.all(meses.map(async (m) => {
        try {
          const { data } = await supabase.functions.invoke('premiacao-comissoes-total', { body: { month: m } });
          return [m, Number((data as any)?.comissao_final) || 0] as const;
        } catch { return [m, 0] as const; }
      }));
      const comissoesPorMes = Object.fromEntries(comissoesPares);

      const modelo = construirRaioX({
        ano, ateMesFechado, os, pagamentos, vendas, pcm,
        comissoesPorMes, recebidosPorMes, pagosPorMes,
      });
      const semTitulo = osSemTitulo(os, titulos);
      const emAberto = titulos.filter(t => !t.liquidado && (t.data_vencimento || '') >= inicio);
      return {
        ...modelo,
        semTitulo,
        semTituloTotal: semTitulo.reduce((a, o) => a + (o.valor_total || 0), 0),
        titulosAbertoTotal: emAberto.reduce((a, t) => a + (t.valor || 0), 0),
        titulosAbertoQtd: emAberto.length,
      };
    },
  });
}
