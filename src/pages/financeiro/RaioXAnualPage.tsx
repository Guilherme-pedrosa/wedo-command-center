// src/pages/financeiro/RaioXAnualPage.tsx — Raio-X do ano: DRE gerencial + caixa pela régua WeDo.
import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RefreshCw, Search, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useRaioXAnual } from '@/hooks/useRaioXAnual';
import { formatBRL, formatPct } from '@/hooks/useMetasResultados';

const kMil = (v: number) => `${Math.round(v / 1000)}`;
const brlMil = (v: number) => `R$ ${Math.round(v / 1000).toLocaleString('pt-BR')} mil`;
const MES_LABEL = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export default function RaioXAnualPage() {
  const anoAtual = new Date().getFullYear();
  const [ano, setAno] = useState(anoAtual);
  const [busca, setBusca] = useState('');
  const query = useRaioXAnual(ano);
  const d = query.data;

  const chartData = useMemo(() => (d?.meses || []).map(m => ({
    mes: MES_LABEL[Number(m.mes.slice(5)) - 1],
    servicos: Math.round(m.recServ), vendas: Math.round(m.recCom),
    margem: Math.round(m.margTot * 1000) / 10,
    caixa: Math.round(m.caixaLiquido),
    resultado: Math.round(m.resTot),
  })), [d]);

  const semTituloFiltrado = useMemo(() => {
    const q = busca.trim().toLocaleLowerCase('pt-BR');
    const lista = d?.semTitulo || [];
    return q ? lista.filter(o => (o.nome_cliente || '').toLocaleLowerCase('pt-BR').includes(q) || String(o.os_codigo).includes(q)) : lista;
  }, [d, busca]);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">📊 Raio-X Anual</h1>
          <p className="text-muted-foreground text-sm mt-1">
            DRE gerencial + caixa, mês a mês, pela régua WeDo — meses fechados de {ano}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(ano)} onValueChange={v => setAno(Number(v))}>
            <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
            <SelectContent>{[anoAtual, anoAtual - 1].map(a => <SelectItem key={a} value={String(a)}>{a}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => query.refetch()} disabled={query.isFetching}>
            <RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {query.isLoading && <p className="text-sm text-muted-foreground py-16 text-center">Consolidando o ano — receitas, custos, comissões e caixa…</p>}
      {query.error && <p className="text-sm text-destructive">Falha ao montar o Raio-X: {(query.error as Error).message}</p>}

      {d && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card><CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><TrendingUp className="h-3.5 w-3.5" />Resultado (DRE)</div>
              <div className={`text-xl font-bold ${d.ytd.resTot >= 0 ? 'text-emerald-500' : 'text-destructive'}`}>{formatBRL(d.ytd.resTot)}</div>
              <div className="text-xs text-muted-foreground mt-0.5">margem {formatPct(d.ytd.margTot)} · receita {brlMil(d.ytd.recTot)}</div>
            </CardContent></Card>
            <Card><CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><Wallet className="h-3.5 w-3.5" />Caixa do período</div>
              <div className={`text-xl font-bold ${d.ytd.caixa >= 0 ? 'text-emerald-500' : 'text-destructive'}`}>{formatBRL(d.ytd.caixa)}</div>
              <div className="text-xs text-muted-foreground mt-0.5">recebido − pago (GC)</div>
            </CardContent></Card>
            <Card><CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><TrendingDown className="h-3.5 w-3.5" />Executado e não recebido</div>
              <div className="text-xl font-bold text-amber-500">{formatBRL(d.naoRecebido)}</div>
              <div className="text-xs text-muted-foreground mt-0.5">receita do período − recebido · ~{formatBRL(d.naoFaturadoEstimado)} sem título</div>
            </CardContent></Card>
            <Card><CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><Wallet className="h-3.5 w-3.5" />Títulos a receber em aberto</div>
              <div className="text-xl font-bold text-foreground">{formatBRL(d.titulosAbertoTotal)}</div>
              <div className="text-xs text-muted-foreground mt-0.5">vencidos {formatBRL(d.titulosVencidosTotal)} ({d.titulosVencidosQtd}) · a vencer {formatBRL(d.titulosAVencerTotal)} ({d.titulosAVencerQtd})</div>
            </CardContent></Card>
          </div>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Receita e margem por mês</CardTitle></CardHeader>
            <CardContent className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.15} vertical={false} />
                  <XAxis dataKey="mes" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis yAxisId="rec" tickFormatter={kMil} tickLine={false} axisLine={false} fontSize={11} width={36} />
                  <YAxis yAxisId="marg" orientation="right" hide domain={[-15, 35]} />
                  <Tooltip formatter={(v: number, name: string) => name === 'Margem %' ? [`${v.toFixed(1)}%`, name] : [brlMil(v), name]}
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} />
                  <Bar yAxisId="rec" dataKey="servicos" name="Operação (OS+PCM)" stackId="r" fill="#3987E5" radius={[0, 0, 0, 0]} maxBarSize={34} />
                  <Bar yAxisId="rec" dataKey="vendas" name="Vendas" stackId="r" fill="#D95926" radius={[3, 3, 0, 0]} maxBarSize={34} />
                  <Line yAxisId="marg" dataKey="margem" name="Margem %" stroke="#E8B93D" strokeWidth={2.5} dot={{ r: 3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Caixa líquido do mês (recebido − pago)</CardTitle></CardHeader>
            <CardContent className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.15} vertical={false} />
                  <XAxis dataKey="mes" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis tickFormatter={kMil} tickLine={false} axisLine={false} fontSize={11} width={44} />
                  <Tooltip formatter={(v: number) => [brlMil(v), 'Caixa']} contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="caixa" radius={[3, 3, 0, 0]} maxBarSize={34}>
                    {chartData.map((c, i) => <Cell key={i} fill={c.caixa >= 0 ? '#3FB950' : '#E5534B'} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="text-base">DRE mensal — régua WeDo (R$ mil)</CardTitle>
                {d.comissoesCarregando
                  ? <Badge variant="outline" className="text-[10px]">Comissões: carregando Premiação… (usando pagas M+1)</Badge>
                  : d.comissoesFallback.length > 0
                    ? <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-500">Comissões pagas (M+1) em {d.comissoesFallback.map(m => MES_LABEL[Number(m.slice(5)) - 1]).join(', ')} — Premiação indisponível</Badge>
                    : <Badge variant="outline" className="text-[10px]">Comissões: tela de Premiação</Badge>}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                Fontes lidas: {d.totais.linhasOs} OS · {d.totais.linhasPagamentos} pagamentos ({formatBRL(d.totais.pagos)} no período) · recebido {formatBRL(d.totais.recebidos)}.
              </p>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-xs whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <thead><tr className="text-muted-foreground border-b border-border">
                  <th className="text-left p-2 pl-4 sticky left-0 bg-card">Linha</th>
                  {d.meses.map(m => <th key={m.mes} className="p-2 text-right">{MES_LABEL[Number(m.mes.slice(5)) - 1]}</th>)}
                </tr></thead>
                <tbody className="text-muted-foreground">
                  {([
                    ['Receita da operação (OS+chamados+PCM)', d.meses.map(m => m.recServ)],
                    ['· mão de obra (rubrica serviços)', d.meses.map(m => m.osMaoDeObra)],
                    ['· peças aplicadas nas OS (venda)', d.meses.map(m => m.osPecasVenda)],
                    ['Receita vendas de produtos', d.meses.map(m => m.recCom)],
                    ['Peças consumidas', d.meses.map(m => -m.pecas)],
                    ['Custo produtos', d.meses.map(m => -m.cmv)],
                    ['Comissões', d.meses.map(m => -m.comissoes)],
                    ['Frota e diretos', d.meses.map(m => -m.diretos)],
                    ['Outros custos (planos fora das metas)', d.meses.map(m => -(m.outros + m.outrosComercial))],
                    ['Impostos (ref. mês)', d.meses.map(m => -m.imposto)],
                    ['Custos fixos', d.meses.map(m => -m.fixos)],
                  ] as [string, number[]][]).map(([nome, vals]) => (
                    <tr key={nome} className="border-b border-border/50">
                      <td className="p-2 pl-4 sticky left-0 bg-card font-medium text-foreground">{nome}</td>
                      {vals.map((v, i) => <td key={i} className="p-2 text-right">{Math.round(v / 1000)}</td>)}
                    </tr>
                  ))}
                  <tr className="border-b border-border font-semibold">
                    <td className="p-2 pl-4 sticky left-0 bg-card text-foreground">Resultado</td>
                    {d.meses.map(m => <td key={m.mes} className={`p-2 text-right ${m.resTot >= 0 ? 'text-emerald-500' : 'text-destructive'}`}>{Math.round(m.resTot / 1000)}</td>)}
                  </tr>
                  <tr>
                    <td className="p-2 pl-4 sticky left-0 bg-card text-foreground">Margem</td>
                    {d.meses.map(m => <td key={m.mes} className={`p-2 text-right ${m.margTot < 0 ? 'text-destructive' : ''}`}>{(m.margTot * 100).toFixed(0)}%{m.impostoEstimado ? '*' : ''}</td>)}
                  </tr>
                </tbody>
              </table>
              <p className="text-[11px] text-muted-foreground px-4 py-2">* imposto estimado pela alíquota efetiva média ({formatPct(d.aliqEfetiva)}) — as guias reais vencem no mês seguinte e substituem a estimativa.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <CardTitle className="text-base">OS sem título rastreável — lista de conferência</CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">
                    {d.semTitulo.length} OS ({formatBRL(d.semTituloTotal)}) sem título que cite o nº da OS. Isso NÃO é o valor a cobrar: clientes por medição agrupada (ex.: Sodexo) já pagaram parte sem citar a OS. O valor real ainda não recebido é o do card acima (~{formatBRL(d.naoFaturadoEstimado)} sem título). Use a lista para conferir cliente a cliente.
                  </p>
                </div>
                <div className="relative w-full sm:w-64">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Filtrar cliente ou nº OS…" className="pl-9 h-9" />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-xs whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <thead><tr className="text-muted-foreground border-b border-border">
                  <th className="text-left p-2 pl-4">OS</th><th className="text-left p-2">Saída</th>
                  <th className="text-left p-2">Cliente</th><th className="text-left p-2">Situação</th>
                  <th className="text-right p-2 pr-4">Valor</th>
                </tr></thead>
                <tbody>
                  {semTituloFiltrado.slice(0, 120).map(o => (
                    <tr key={o.os_codigo} className="border-b border-border/50">
                      <td className="p-2 pl-4 font-medium text-foreground">{o.os_codigo}</td>
                      <td className="p-2 text-muted-foreground">{o.data_saida ? `${o.data_saida.slice(8, 10)}/${o.data_saida.slice(5, 7)}` : '—'}</td>
                      <td className="p-2 text-muted-foreground max-w-[260px] truncate">{o.nome_cliente}</td>
                      <td className="p-2"><Badge variant="outline" className="text-[10px]">{(o.nome_situacao || '').replace('EXECUTADO - ', '')}</Badge></td>
                      <td className="p-2 pr-4 text-right font-medium text-foreground">{formatBRL(o.valor_total || 0)}</td>
                    </tr>
                  ))}
                  {semTituloFiltrado.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">Nenhuma OS encontrada.</td></tr>}
                </tbody>
              </table>
              {semTituloFiltrado.length > 120 && <p className="text-[11px] text-muted-foreground px-4 py-2">Mostrando as 120 maiores — use o filtro para achar as demais.</p>}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
