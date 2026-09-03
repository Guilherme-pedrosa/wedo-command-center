// src/lib/raioXAnual.ts — modelo anual (DRE gerencial + caixa) pela régua WeDo.
// Regras (Guilherme, 03/09/2026):
// - Receita de serviços = OS Execução+Coifas + chamados Ecolab (data_saida) + PCM confirmado.
// - Peças pelo custo consumido nas OS; CMV das vendas pelo valor_custo do payload.
// - Impostos do mês M = guias com vencimento em M+1; sem guia (< 50% da alíquota média), estima.
// - Comissões pela tela de Premiação.
// - Custeio: fixos 100% nos serviços; comercial carrega folha Filipe/Pedro, 20% do pró-labore,
//   imposto proporcional e o CMV.
import { isLancamentoFolhaComercial, PLANOS_IMPOSTO_IDS, PROLABORE_FRACAO_COMERCIAL } from '@/hooks/useMetasResultados';

export const OS_EXEC_STATUS = [
  'EXECUTADO - AGUARDANDO NEGOCIAÇÃO FINANCEIRA',
  'EXECUTADO - AGUARDANDO PAGAMENTO',
  'EXECUTADO COM NOTA EMITIDA',
  'EXECUTADO - FINANCEIRO SEPARADO',
];
export const OS_CHAMADO_STATUS = ['EXECUTADO - FECHADO CHAMADO', 'CHAMADO FECHADO - FATURADO'];

export type OsRow = {
  os_codigo: string; nome_cliente: string | null; nome_situacao: string | null;
  valor_total: number | null; valor_pecas?: number | null; valor_pecas_custo: number | null; data_saida: string | null;
};
export type PagamentoRow = {
  plano_contas_id: string | null; valor: number; data_vencimento: string | null;
  descricao?: string | null; nome_fornecedor?: string | null; categoria_meta?: 'custo_fixo' | 'custo_variavel' | null;
  nome_meta?: string | null;
};
export type VendaRow = { valor_total: number | null; custo: number; data: string | null; interna: boolean };
export type PcmRow = { valor: number; data_vencimento: string | null };
export type RecebimentoTituloRow = { os_codigo: string | null; descricao: string | null; valor: number; liquidado: boolean; data_liquidacao: string | null; data_vencimento: string | null };

export type MesRaioX = {
  mes: string;
  recServ: number; recCom: number; recTot: number;
  osMaoDeObra: number; osPecasVenda: number;
  pecas: number; cmv: number; comissoes: number; fixos: number; diretos: number;
  imposto: number; impostoEstimado: boolean; folhaComercial: number; prolabore20: number;
  resServ: number; resCom: number; resTot: number;
  margTot: number; margServ: number; margCom: number;
  caixaRecebido: number; caixaPago: number; caixaLiquido: number;
};

const mesDe = (d: string | null | undefined) => (d ? String(d).slice(0, 7) : '');
const soma = (a: number[]) => a.reduce((x, y) => x + y, 0);

export function mesesDoAno(ano: number, ateMesFechado: number): string[] {
  const out: string[] = [];
  for (let m = 1; m <= ateMesFechado; m++) out.push(`${ano}-${String(m).padStart(2, '0')}`);
  return out;
}

export function construirRaioX(input: {
  ano: number;
  ateMesFechado: number; // último mês fechado (ex.: 8 em setembro)
  os: OsRow[];
  pagamentos: PagamentoRow[]; // do ano até ateMesFechado+1 (para o imposto ref M+1)
  vendas: VendaRow[];
  pcm: PcmRow[];
  comissoesPorMes: Record<string, number>;
  recebidosPorMes: Record<string, number>; // caixa: liquidados por mês
  pagosPorMes: Record<string, number>; // caixa: todos os pagamentos por mês
}) {
  const meses = mesesDoAno(input.ano, input.ateMesFechado);
  const proximoMes = (m: string) => {
    const [y, mm] = m.split('-').map(Number);
    return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
  };

  const impostosPorVenc: Record<string, number> = {};
  const fixosPorMes: Record<string, number> = {};
  const diretosPorMes: Record<string, number> = {};
  const folhaComPorMes: Record<string, number> = {};
  const prolaborePorMes: Record<string, number> = {};
  for (const p of input.pagamentos) {
    const m = mesDe(p.data_vencimento);
    if (!m) continue;
    const v = Math.abs(p.valor || 0);
    const plano = String(p.plano_contas_id || '');
    if (PLANOS_IMPOSTO_IDS.has(plano)) { impostosPorVenc[m] = (impostosPorVenc[m] || 0) + v; continue; }
    if (p.categoria_meta === 'custo_fixo') {
      fixosPorMes[m] = (fixosPorMes[m] || 0) + v;
      if ((p.nome_meta || '').toLowerCase().includes('labore')) prolaborePorMes[m] = (prolaborePorMes[m] || 0) + v;
      if (isLancamentoFolhaComercial(plano, p)) folhaComPorMes[m] = (folhaComPorMes[m] || 0) + v;
    } else if (p.categoria_meta === 'custo_variavel') {
      const n = (p.nome_meta || '').toLowerCase();
      // Peças (usamos consumo, não compra), comissões (Premiação) e custo de venda ficam fora.
      if (n.includes('peça') || n.includes('peca') || n.includes('estoque') || n.includes('comiss') || n.includes('premia') || (n.includes('venda') && n.includes('produto'))) continue;
      if (n.includes('impost')) continue;
      diretosPorMes[m] = (diretosPorMes[m] || 0) + v;
    }
  }

  const osExecPorMes: Record<string, { total: number; pecas: number; pecasVenda: number }> = {};
  const chamadosPorMes: Record<string, number> = {};
  for (const o of input.os) {
    const m = mesDe(o.data_saida);
    if (!m) continue;
    const sit = o.nome_situacao || '';
    if (OS_EXEC_STATUS.includes(sit)) {
      const b = (osExecPorMes[m] ||= { total: 0, pecas: 0, pecasVenda: 0 });
      b.total += o.valor_total || 0;
      b.pecas += o.valor_pecas_custo || 0;
      b.pecasVenda += o.valor_pecas || 0;
    } else if (OS_CHAMADO_STATUS.includes(sit)) {
      chamadosPorMes[m] = (chamadosPorMes[m] || 0) + (o.valor_total || 0);
    }
  }
  const vendasPorMes: Record<string, { total: number; cmv: number; usoInterno: number }> = {};
  for (const v of input.vendas) {
    const m = mesDe(v.data);
    if (!m) continue;
    const b = (vendasPorMes[m] ||= { total: 0, cmv: 0, usoInterno: 0 });
    if (v.interna) b.usoInterno += v.custo;
    else { b.total += v.valor_total || 0; b.cmv += v.custo; }
  }
  const pcmPorMes: Record<string, number> = {};
  for (const r of input.pcm) {
    const m = mesDe(r.data_vencimento);
    if (m) pcmPorMes[m] = (pcmPorMes[m] || 0) + (r.valor || 0);
  }

  // alíquota efetiva média dos meses com guia cheia (para estimar o mês sem guias)
  let sImp = 0, sRec = 0;
  for (const m of meses) {
    const guia = impostosPorVenc[proximoMes(m)] || 0;
    const rec = (osExecPorMes[m]?.total || 0) + (chamadosPorMes[m] || 0) + (pcmPorMes[m] || 0) + (vendasPorMes[m]?.total || 0);
    if (rec > 0 && guia > rec * 0.05) { sImp += guia; sRec += rec; }
  }
  const aliqEfetiva = sRec > 0 ? sImp / sRec : 0.10;

  const out: MesRaioX[] = meses.map((m) => {
    const oe = osExecPorMes[m] || { total: 0, pecas: 0, pecasVenda: 0 };
    const vd = vendasPorMes[m] || { total: 0, cmv: 0, usoInterno: 0 };
    const recServ = oe.total + (chamadosPorMes[m] || 0) + (pcmPorMes[m] || 0);
    const recCom = vd.total;
    const recTot = recServ + recCom;
    const guia = impostosPorVenc[proximoMes(m)] || 0;
    const impostoEstimado = recTot > 0 && guia < recTot * aliqEfetiva * 0.5;
    const imposto = impostoEstimado ? Math.round(recTot * aliqEfetiva) : guia;
    const fixos = fixosPorMes[m] || 0;
    const diretos = diretosPorMes[m] || 0;
    const comissoes = input.comissoesPorMes[m] || 0;
    const folhaComercial = folhaComPorMes[m] || 0;
    const prolabore20 = (prolaborePorMes[m] || 0) * PROLABORE_FRACAO_COMERCIAL;
    const pecas = oe.pecas + vd.usoInterno;
    const impServ = recTot > 0 ? imposto * (recServ / recTot) : imposto;
    const resServ = recServ - (pecas + comissoes + (fixos - folhaComercial - prolabore20) + diretos + impServ);
    const resCom = recCom - (vd.cmv + folhaComercial + prolabore20 + (imposto - impServ));
    const caixaRecebido = input.recebidosPorMes[m] || 0;
    const caixaPago = input.pagosPorMes[m] || 0;
    return {
      mes: m, recServ, recCom, recTot,
      osMaoDeObra: Math.max(0, oe.total - oe.pecasVenda), osPecasVenda: oe.pecasVenda,
      pecas, cmv: vd.cmv, comissoes, fixos, diretos,
      imposto, impostoEstimado, folhaComercial, prolabore20,
      resServ, resCom, resTot: resServ + resCom,
      margTot: recTot > 0 ? (resServ + resCom) / recTot : 0,
      margServ: recServ > 0 ? resServ / recServ : 0,
      margCom: recCom > 0 ? resCom / recCom : 0,
      caixaRecebido, caixaPago, caixaLiquido: caixaRecebido - caixaPago,
    };
  });

  const ytd = {
    recTot: soma(out.map(x => x.recTot)), recServ: soma(out.map(x => x.recServ)), recCom: soma(out.map(x => x.recCom)),
    resTot: soma(out.map(x => x.resTot)), resServ: soma(out.map(x => x.resServ)), resCom: soma(out.map(x => x.resCom)),
    caixa: soma(out.map(x => x.caixaLiquido)),
    margTot: 0,
  };
  ytd.margTot = ytd.recTot > 0 ? ytd.resTot / ytd.recTot : 0;
  return { meses: out, ytd, aliqEfetiva };
}

// OS executadas sem título rastreável no contas a receber (candidatas a "nunca faturadas").
// Nota: clientes que pagam por medição agrupada podem aparecer aqui mesmo pagos — conferir.
export function osSemTitulo(os: OsRow[], titulos: RecebimentoTituloRow[]) {
  const comTitulo = new Set<string>();
  for (const t of titulos) {
    if (t.os_codigo) comTitulo.add(String(t.os_codigo));
    const m = String(t.descricao || '').match(/n[ºo°]\s*(\d+)/i);
    if (m) comTitulo.add(m[1]);
  }
  return os
    .filter(o => OS_EXEC_STATUS.includes(o.nome_situacao || '') && (o.valor_total || 0) > 0)
    .filter(o => !comTitulo.has(String(o.os_codigo)))
    .sort((a, b) => (b.valor_total || 0) - (a.valor_total || 0));
}
