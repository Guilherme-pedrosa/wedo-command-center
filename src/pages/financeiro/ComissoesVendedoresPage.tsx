import { Fragment } from 'react';
import { ResumoCustosComissao } from '@/components/financeiro/ResumoCustosComissao';
import { PainelComissoesVendedor } from '@/components/financeiro/PainelComissoesVendedor';
import { AlterarSituacaoComissoesDialog } from '@/components/financeiro/AlterarSituacaoComissoesDialog';
import { HistoricoSituacaoComissao } from '@/components/financeiro/HistoricoSituacaoComissao';
import { FretesComissoes } from '@/components/financeiro/FretesComissoes';
import { exportarExcel } from '@/lib/comissoes/exportarExcel';
import { FiltroMultiploComissoes } from '@/components/financeiro/FiltroMultiploComissoes';
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { Download, RefreshCw, Users, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { carregarComissoes, registrarPagamento, salvarConferencia, salvarParametros } from '@/lib/comissoes/api';
import { calcularVenda, assinaturaVenda, periodoComissao, type Conferencia, type DadosVenda, type Parametros } from '@/lib/comissoes/calculo';
import { tabelaValida } from '@/lib/comissoes/taxasRecebimento';
import { formatBRL, formatPct, parseMoney, DEFAULT_DESLOCAMENTO } from '@/lib/comissoes/analisePickPack';

const hoje = () => format(new Date(), 'yyyy-MM-dd');
const dataBR = (s?: string) => s ? s.slice(0,10).split('-').reverse().join('/') : '—';
const selectClass = 'h-10 rounded-md border bg-background px-3 text-sm';
type Calculada = ReturnType<typeof calcularVenda>;

export default function ComissoesVendedoresPage() {
  const [mes,setMes]=useState(format(new Date(),'yyyy-MM'));
  const [periodo,setPeriodo]=useState(periodoComissao(mes,'mes'));
  const [vendedor,setVendedor]=useState<string[]>([]);
  const [situacoesGC,setSituacoesGC]=useState<string[]>([]);
  const [status,setStatus]=useState<string[]>([]);
  const [busca,setBusca]=useState('');
  const [exportando,setExportando]=useState(false);
  const exportar=async(rows:Calculada[])=>{setExportando(true);try{await exportarExcel(rows,{...periodo,vendedores:vendedor,situacoesGC,pagamentos:status,busca});}catch(e){toast.error(`Falha ao exportar Excel: ${(e as Error).message}`);}finally{setExportando(false);}};
  const [progressoFinanceiro,setProgressoFinanceiro]=useState('');
  const [selecionada,setSelecionada]=useState<string|null>(null);
  const [visualizacao,setVisualizacao]=useState<'vendedor'|'venda'>('vendedor');
  const [alteracaoSituacao,setAlteracaoSituacao]=useState<{ids:string[];retirada:boolean}|null>(null);
  const alterarSituacao=(ids:string[],retirada:boolean)=>{setSelecionada(null);setAlteracaoSituacao({ids,retirada});};
  const [parametrosAberto,setParametrosAberto]=useState(false);
  const { isAdmin }=useAuth();
  const query=useQuery({refetchOnWindowFocus:false,staleTime:60000,queryKey:['comissoes',periodo],queryFn:()=>carregarComissoes(periodo.inicio,periodo.fim,(n,total,etapa='clientes')=>setProgressoFinanceiro(`Conferindo GC: ${n} de ${total} ${etapa}`)),retry:1});
  const linhas=useMemo(()=>query.data?.vendas.map(v=>calcularVenda(v,query.data.parametros))??[],[query.data]);
  const vendedores=[...new Set(linhas.map(r=>r.vendedor||'Sem vendedor'))].sort();
  const filtradas=linhas.filter(r=>(!vendedor.length||vendedor.includes(r.vendedor||'Sem vendedor'))&&(!situacoesGC.length||situacoesGC.includes(r.venda.nome_situacao||'Não informada'))&&
    (!status.length||status.some(s=>s==='comissao-retirada'?r.retirada:s==='comissao-ativa'?!r.retirada:s==='avisos'?r.avisos.length>0:s==='sem-forma'?r.formaAusente:s==='comissao-paga'?r.pago>0:r.recebimento===s))&&
    `${r.venda.codigo} ${r.venda.nome_cliente} ${r.vendedor} ${r.a.linhas.map(l=>l.nome).join(' ')}`.toLowerCase().includes(busca.toLowerCase()));
  const soma=(key:'comissao'|'comissaoCalculada'|'comissaoRetirada'|'pago'|'base'|'recebido')=>filtradas.reduce((s,r)=>s+r[key],0);
  const atual=linhas.find(r=>r.venda.id===selecionada);
  return <div className="p-4 md:p-6 space-y-5">
    <div className="flex flex-wrap justify-between gap-3"><div><h1 className="text-2xl font-semibold flex gap-2 items-center"><Users/> Comissões de vendedores</h1><p className="text-sm text-muted-foreground">Conferência de vendas de produtos, margem, recebimentos e pagamento das comissões.</p></div><div className="flex gap-2"><Button variant="outline" onClick={()=>void query.refetch()} disabled={query.isFetching}><RefreshCw className="mr-2 h-4 w-4"/>{query.data?.origemConsulta==='snapshot'?'Recarregar prévia':'Atualizar financeiro do GC'}</Button><Button variant="outline" disabled={!filtradas.length||exportando} onClick={()=>void exportar(filtradas)}><Download className="mr-2 h-4 w-4"/>{exportando?'Gerando Excel…':'Exportar Excel'}</Button><Button variant="outline" disabled={!query.data} onClick={()=>setParametrosAberto(true)}>Custos e regras</Button></div></div>
    <div className="rounded-lg border bg-muted/30 p-3 text-sm">Margem acima de 20%: <b>5%</b> · De 12% até 20%: <b>3%</b> · Abaixo de 12%: <b>sem comissão</b>. Base: valor dos produtos após descontos. Serviços e frete ficam fora da base.</div>
    <Card><CardContent className="pt-5 flex flex-wrap gap-3 items-end">
      <label className="space-y-1 text-sm">Mês<Input type="month" value={mes} onChange={e=>{setMes(e.target.value);if(e.target.value)setPeriodo(periodoComissao(e.target.value,'mes'));}}/></label>
      <Button variant="outline" onClick={()=>setPeriodo({inicio:hoje(),fim:hoje()})}>Hoje</Button>
      <Button variant="outline" disabled={!mes} onClick={()=>setPeriodo(periodoComissao(mes,'mes'))}>Mês inteiro</Button>
      <Button variant="outline" disabled={!mes} onClick={()=>setPeriodo(periodoComissao(mes,'primeira'))}>1ª quinzena</Button>
      <Button variant="outline" disabled={!mes} onClick={()=>setPeriodo(periodoComissao(mes,'segunda'))}>2ª quinzena</Button>
      <label className="space-y-1 text-sm">Data da venda: de<Input type="date" value={periodo.inicio} onChange={e=>setPeriodo(p=>({...p,inicio:e.target.value}))}/></label>
      <label className="space-y-1 text-sm">Até<Input type="date" value={periodo.fim} onChange={e=>setPeriodo(p=>({...p,fim:e.target.value}))}/></label>
      <FiltroMultiploComissoes label="Vendedores" opcoes={vendedores.map(v=>({valor:v,nome:v}))} selecionados={vendedor} onChange={setVendedor}/>
      <FiltroMultiploComissoes label="Situação no GC" opcoes={[...new Set(linhas.map(r=>String(r.venda.nome_situacao||'Não informada')))].sort().map(v=>({valor:v,nome:v}))} selecionados={situacoesGC} onChange={setSituacoesGC}/>
      <FiltroMultiploComissoes label="Pagamento e conferência" opcoes={[["comissao-ativa","Comissões ativas"],["comissao-retirada","Comissões retiradas"],["Recebido","Cliente pagou"],["Parcial","Recebido parcialmente"],["Em aberto","Cliente não pagou"],["Financeiro pendente de consulta","Financeiro pendente de consulta"],["Conferir valores do financeiro","Valores financeiros divergentes"],["Títulos não localizados no GC","Títulos não localizados no GC"],["sem-forma","Sem forma de pagamento"],["comissao-paga","Comissão com pagamento"],["avisos","Com pendências"]].map(([valor,nome])=>({valor,nome}))} selecionados={status} onChange={setStatus}/>
      <Input className="max-w-sm" aria-label="Buscar venda, cliente ou produto" placeholder="Venda, cliente ou produto…" value={busca} onChange={e=>setBusca(e.target.value)}/>
    </CardContent></Card>
    {query.isPending||query.isFetching?<p role="status">Carregando conferência… {progressoFinanceiro}</p>:query.isError?<div role="alert" className="text-destructive">Não foi possível carregar as comissões: {(query.error as Error).message}. <Button variant="outline" onClick={()=>void query.refetch()}>Tentar novamente</Button></div>:<>
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">{[['Vendas de produtos',formatBRL(soma('base'))],['Comissão calculada',formatBRL(soma('comissaoCalculada'))],['Comissões retiradas',formatBRL(soma('comissaoRetirada'))],['Comissão devida',formatBRL(soma('comissao'))],['Comissão paga registrada',formatBRL(soma('pago'))],['Recebido dos clientes',formatBRL(soma('recebido'))]].map(([label,value])=><Card key={label}><CardContent className="pt-5"><p className="text-sm text-muted-foreground">{label}</p><p className="text-2xl font-semibold">{value}</p></CardContent></Card>)}</div>
      <p className="text-xs text-muted-foreground">{filtradas.length} venda(s). Margem para a faixa: {query.data?.parametros.margemAposComissao?'após':'antes de'} descontar a própria comissão. Recebimentos consideram todas as parcelas das vendas selecionadas, inclusive fora do período. “Recebido” indica baixa no GC, não conciliação bancária.</p>
      <p className="text-amber-500 text-sm" role="status">{query.data?.avisoFretes}</p>
      <FretesComissoes fontes={query.data?.fretes??[]} rateios={query.data?.rateios??[]}/>
      <div role="group" aria-label="Visualização das comissões" className="flex gap-2"><Button variant={visualizacao==='vendedor'?'default':'outline'} aria-pressed={visualizacao==='vendedor'} onClick={()=>setVisualizacao('vendedor')}>Por vendedor</Button><Button variant={visualizacao==='venda'?'default':'outline'} aria-pressed={visualizacao==='venda'} onClick={()=>setVisualizacao('venda')}>Por venda</Button></div>
      {visualizacao==='vendedor'?<PainelComissoesVendedor linhas={filtradas} isAdmin={isAdmin} onConferir={setSelecionada} onAlterarSituacao={alterarSituacao}/>:<div className="rounded-lg border overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/40"><tr>{['Venda / data','Vendedor / cliente','Produtos','Valor / margem','Comissão','Pagamento do cliente','Forma de pagamento','Conferência'].map(h=><th className="p-3 text-left whitespace-nowrap" key={h}>{h}</th>)}</tr></thead><tbody>{filtradas.map(r=><Fragment key={r.venda.id}><tr className="border-t align-top hover:bg-muted/20">
        <td className="p-3 whitespace-nowrap"><a href={`https://gestaoclick.com/pedidos/vendas/vendas_produtos/visualizar/${encodeURIComponent(r.venda.gc_id)}`} target="_blank" rel="noreferrer" className="text-primary underline">{r.venda.codigo}</a><p>{dataBR(r.venda.data)}</p><p className="text-xs text-muted-foreground">{r.venda.nome_situacao}</p></td>
        <td className="p-3 min-w-48"><b>{r.vendedor||'Vendedor não informado'}</b><p>{r.venda.nome_cliente}</p></td>
        <td className="p-3 min-w-52">{r.a.linhas.filter(l=>l.tipo==='produto').slice(0,3).map((l,i)=><p key={i}>{l.quantidade} × {l.nome}</p>)}{r.a.linhas.length>3&&<p className="text-muted-foreground">Ver todos em Conferir</p>}</td>
        <td className="p-3 whitespace-nowrap"><b>{formatBRL(r.a.receitaLiquida)}</b><p className="text-xs">Custo produtos GC: {formatBRL(r.a.custoProdutos)}</p><p className="text-xs">Impostos/despesas: {formatBRL(r.a.receitaLiquida-r.lucroAntes-r.a.custoProdutos-r.a.custoServicos)}</p><p className={r.margemAntes===null||r.percentual===0?'text-amber-500':'text-emerald-500'}>{r.margemAntes===null?'Custo pendente':`${formatPct(r.margemAntes,2)} antes da comissão`}</p><p className="text-xs">Final: {r.margemFinal===null?'—':formatPct(r.margemFinal,2)}</p></td>
        <td className="p-3 whitespace-nowrap"><b>{formatBRL(r.comissao)} ({r.percentual}%)</b>{r.retirada&&<p className="text-amber-500 text-xs">Retirada · <s>{formatBRL(r.comissaoCalculada)}</s></p>}<p>{r.pagamentos.length ? `Pago: ${formatBRL(r.pago)}` : "Pagamento não registrado"}</p><p>Saldo: {formatBRL(r.saldo)}</p></td>
        <td className="p-3 min-w-40"><b>{r.recebimento}</b><p>{formatBRL(r.recebido)}</p><p className="text-xs">{r.recebimentos.length} título(s) localizado(s)</p></td>
        <td className="p-3 min-w-36">{r.formas.join(' / ')||'Não informada'}{r.formaAusente&&<p className="text-amber-500">Há parcela sem forma</p>}</td>
        <td className="p-3 min-w-52"><Button variant="outline" size="sm" onClick={()=>setSelecionada(r.venda.id)}>Conferir</Button><div className="mt-1">{isAdmin&&<Button variant="ghost" size="sm" onClick={()=>alterarSituacao([r.venda.id],!r.retirada)}>{r.retirada?'Reincluir comissão':'Retirar comissão'}</Button>}</div><p className="text-xs mt-1">{r.conferidaAtual?'Conferida':'A conferir'}</p>{r.avisos.map(x=><p key={x} className="text-xs text-amber-500 mt-1">{x}</p>)}</td>
      </tr><tr className="border-t bg-muted/10"><td colSpan={8} className="p-3"><ResumoCustosComissao linha={r}/></td></tr></Fragment>)}</tbody></table>{!filtradas.length&&<p className="p-8 text-center text-muted-foreground">Nenhuma venda encontrada para estes filtros.</p>}</div>}
      <div className="text-xs text-muted-foreground">Dados sincronizados do GC. Última sincronização das vendas exibidas: {filtradas.length ? dataBR(filtradas.map(r=>r.venda.last_synced_at||'').sort()[0]):'—'}. Custos sem informação não são tratados como lucro.</div>
    </>}
    {atual&&query.data&&<Detalhes key={atual.venda.id} dados={atual} rateios={query.data.rateios??[]} parametros={query.data.parametros} isAdmin={isAdmin} onClose={()=>setSelecionada(null)} onAlterarSituacao={()=>alterarSituacao([atual.venda.id],!atual.retirada)}/>}
    {alteracaoSituacao&&<AlterarSituacaoComissoesDialog linhas={linhas.filter(r=>alteracaoSituacao.ids.includes(r.venda.id))} retirada={alteracaoSituacao.retirada} onClose={()=>setAlteracaoSituacao(null)}/>}
    {parametrosAberto&&query.data&&<ParametrosDialog parametros={query.data.parametros} isAdmin={isAdmin} onClose={()=>setParametrosAberto(false)}/>}
  </div>;
}

function Numero({label,value,onChange}:{label:string;value:number;onChange:(n:number)=>void}) { return <label className="text-sm space-y-1">{label}<Input type="number" min="0" step="0.01" value={value} onChange={e=>onChange(e.target.value===''?0:Number(e.target.value))}/></label>; }

function Detalhes({dados,parametros,isAdmin,onClose,rateios,onAlterarSituacao}:{rateios:Record<string,any>[];dados:Calculada;parametros:Parametros;isAdmin:boolean;onClose:()=>void;onAlterarSituacao:()=>void}) {
  const qc=useQueryClient();
  const [ajustes,setAjustes]=useState<Conferencia['ajustes']>({...dados.conferencia?.ajustes,extras:dados.extras,deslocamento:dados.conferencia?.ajustes.deslocamento??DEFAULT_DESLOCAMENTO});
  const [salvando,setSalvando]=useState(false);
  const [valor,setValor]=useState(Math.max(0,dados.saldo));
  const [data,setData]=useState(hoje());
  const [forma,setForma]=useState('');
  const [obs,setObs]=useState('');
  const [pagamentoId]=useState(()=>crypto.randomUUID());
  const sim=calcularVenda({...dados,conferencia:{...dados.conferencia,venda_id:dados.venda.id,ajustes,conferido:false}},parametros);
  const [alterado,setAlterado]=useState(false);
  const atualizar=(patch:Partial<Conferencia['ajustes']>)=>{setAjustes(a=>({...a,...patch}));setAlterado(true);};
  const salvar=async()=>{if((ajustes.fretes??[]).some(r=>!Number.isFinite(r.valor)||r.valor<0||!r.justificativa.trim()||r.valor+(rateios.filter(x=>x.venda_id!==dados.venda.id).flatMap(x=>x.fretes??[]).filter(x=>x.fonteId===r.fonteId).reduce((s,x)=>s+Number(x.valor),0))>r.limite+0.001)){toast.error('Confira o saldo, valor e justificativa dos fretes.');return;}if(ajustes.vendedorNome?.trim()&&!ajustes.justificativa?.trim()){toast.error('Informe a justificativa da identificação do vendedor.');return;}setSalvando(true);try{await salvarConferencia({venda_id:dados.venda.id,ajustes,conferido:true,assinatura:assinaturaVenda({...dados,conferencia:{...dados.conferencia,venda_id:dados.venda.id,ajustes,conferido:true}},parametros)});await qc.invalidateQueries({queryKey:['comissoes']});setAlterado(false);toast.success('Conferência salva com histórico.');}catch(e){toast.error((e as Error).message);}finally{setSalvando(false);}};
  const pagar=async()=>{setSalvando(true);try{await registrarPagamento({id:pagamentoId,venda_id:dados.venda.id,valor,data_pagamento:data,forma_pagamento:forma,observacao:obs,snapshot:{vendedor:dados.vendedor,comissao:dados.comissao,percentual:dados.percentual,margemAntes:dados.margemAntes,margemFinal:dados.margemFinal,assinatura:dados.conferencia?.assinatura}});await qc.invalidateQueries({queryKey:['comissoes']});toast.success('Pagamento da comissão registrado.');onClose();}catch(e){toast.error((e as Error).message);}finally{setSalvando(false);}};
  return <Dialog open onOpenChange={onClose}><DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>Conferir venda {dados.venda.codigo}</DialogTitle></DialogHeader>
    <p>{dados.venda.nome_cliente} · {dataBR(dados.venda.data)}</p><p className="text-sm">Vendedor no GC: <b>{dados.vendedorOriginal||'Não informado'}</b></p>
    <div className="rounded border p-3 space-y-2"><p className="text-sm font-medium">{dados.retirada?'Comissão retirada':'Comissão ativa'}</p>{dados.retirada&&<p className="text-sm whitespace-pre-wrap">{dados.conferencia?.motivo_retirada}</p>}{isAdmin&&<Button variant="outline" disabled={salvando||alterado} onClick={onAlterarSituacao}>{dados.retirada?'Reincluir comissão':'Retirar comissão'}</Button>}{alterado&&<p className="text-xs text-amber-500">Salve os ajustes da conferência antes de alterar a situação da comissão.</p>}</div>
    <fieldset disabled={!isAdmin||salvando} className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-3"><label className="text-sm">Vendedor conferido (se o GC estiver incorreto)<Input value={ajustes.vendedorNome??''} onChange={e=>atualizar({vendedorNome:e.target.value})}/></label><label className="text-sm">Justificativa / observações<Input value={ajustes.justificativa??''} onChange={e=>atualizar({justificativa:e.target.value})}/></label></div>
      <details><summary className="cursor-pointer font-medium">Conferir despesas operacionais desta venda</summary><p className="text-xs text-muted-foreground mt-2">Alimentação, administração, premiação, custo financeiro e restorno só são descontados quando ativados nesta conferência.</p><div className="grid sm:grid-cols-3 gap-3 mt-3">
        {(['dias','tecnicos','horasAdmin','pedagio','hospedagem','parcelas'] as const).map((key,i)=><Numero key={key} label={['Dias','Técnicos','Horas administrativas','Pedágio (R$)','Hospedagem (R$)','Parcelas'][i]} value={ajustes.extras![key]} onChange={n=>atualizar({extras:{...ajustes.extras!,[key]:n}})}/>)}
        <Numero label="Outros custos comprovados (R$)" value={ajustes.custoAdicional??0} onChange={n=>atualizar({custoAdicional:n})}/>
        {(['considerarAlimentacao','considerarAdmin','considerarPremiacao','considerarParcelamento','considerarRestorno'] as const).map((key,i)=><label key={key} className="flex gap-2 text-sm"><input type="checkbox" checked={!!ajustes.extras![key]} onChange={e=>atualizar({extras:{...ajustes.extras!,[key]:e.target.checked}})}/>{['Alimentação','Mão de obra administrativa','Premiação de técnico','Custo financeiro do prazo','Restorno contratual Sapore (8%)'][i]}</label>)}
      </div></details>
      <FretesComissoes fontes={dados.fretes??[]} rateios={rateios} venda={dados.venda} selecionados={ajustes.fretes??[]} onChange={fretes=>atualizar({fretes})}/>
      <Button onClick={()=>void salvar()} disabled={salvando}>{salvando?'Salvando…':'Salvar conferência'}</Button>
    </fieldset>
    <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['Item','Qtd.','Venda','Custo'].map(x=><th className="text-left p-2" key={x}>{x}</th>)}</tr></thead><tbody>{sim.a.linhas.map((l,i)=><tr className="border-t" key={i}><td className="p-2">{l.nome} <span className="text-muted-foreground">({l.tipo})</span></td><td>{l.quantidade}</td><td>{formatBRL(l.receita)}</td><td>{l.semCusto?'Custo pendente':formatBRL(l.custo)}</td></tr>)}</tbody></table></div>
    <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">{[['Valor da venda',sim.a.receitaLiquida],['Custo dos produtos no GC',sim.a.custoProdutos],['Custo dos serviços',sim.a.custoServicos],['Deslocamento adicional',sim.a.deslocamento.custoAdicional],['Alimentação',sim.a.extras.alimentacao],['Administrativo',sim.a.extras.moAdmin],['Premiação técnica',sim.a.extras.premiacao],['Pedágio e hospedagem',sim.a.extras.pedagio+sim.a.extras.hospedagem],['Restorno',sim.a.extras.restorno],['Custo do parcelamento',sim.a.extras.parcelamento],['Impostos (parâmetro gerencial)',sim.a.imposto],['Rateio fixo e garantia',sim.a.custoFixo+sim.a.garantia],['Descontos e taxas do recebimento',sim.taxasRecebimento],['Frete rateado adicional',sim.custoFrete],['Outros custos',sim.custoAdicional],['Lucro antes da comissão',sim.lucroAntes],['Comissão calculada',sim.comissaoCalculada],['Comissão retirada',sim.comissaoRetirada],['Comissão devida',sim.comissao]].map(([label,n])=><p className="flex justify-between gap-2" key={String(label)}><span>{label}</span><b>{formatBRL(Number(n))}</b></p>)}</div>
    <p className="font-medium">Margem antes: {sim.margemAntes===null?'Pendente':formatPct(sim.margemAntes,2)} · Comissão: {sim.percentual}% · Margem final: {sim.margemFinal===null?'Pendente':formatPct(sim.margemFinal,2)}</p>
    {sim.avisos.length>0&&<div className="rounded border border-amber-500/40 p-3 text-amber-500 text-sm"><AlertTriangle className="inline h-4 w-4 mr-2"/>{sim.avisos.join(' · ')}</div>}
    <h3 className="font-semibold">Recebimentos do cliente no GC</h3><p className="text-sm">{dados.recebimento} · recebido {formatBRL(dados.recebido)} de {formatBRL(dados.totalTitulos)} em títulos vinculados.</p>
    {dados.recebimentos.map(r=><p key={r.gc_id} className="text-sm border-t pt-2">#{r.gc_codigo} · {formatBRL(parseMoney(r.valor_total ?? r.valor))} · vence {dataBR(r.data_vencimento)} · {r.liquidado?`Baixado em ${dataBR(r.data_liquidacao)}`:'Em aberto'} · {r.nome_cliente} · {r.nome_forma_pagamento||'Forma não informada'}</p>)}
    <HistoricoSituacaoComissao vendaId={dados.venda.id}/>
    <h3 className="font-semibold">Pagamentos da comissão</h3>{dados.pagamentos.map(p=><p key={p.id} className="text-sm">{dataBR(p.data_pagamento)} · {formatBRL(p.valor)} · {p.forma_pagamento} · {p.observacao}</p>)}{!dados.pagamentos.length&&<p className="text-sm text-muted-foreground">Nenhum pagamento de comissão registrado.</p>}
    {isAdmin&&<fieldset disabled={dados.retirada||salvando||alterado||dados.consultaFretes==='pendente'||dados.fretesPendentes.length>0||!dados.conferidaAtual||!dados.custosValidos||!dados.percentual||!dados.vendedor||/\bAPI\b/i.test(dados.vendedor)} className="border rounded-lg p-3 space-y-3"><p className="text-sm">Registrar pagamento já realizado ao vendedor. Este registro não transfere dinheiro nem baixa títulos no GC. Salve a conferência antes de registrar.</p><div className="grid sm:grid-cols-3 gap-3"><Numero label="Valor pago" value={valor} onChange={setValor}/><label className="text-sm">Data<Input type="date" value={data} max={hoje()} onChange={e=>setData(e.target.value)}/></label><label className="text-sm">Forma de pagamento<Input value={forma} onChange={e=>setForma(e.target.value)}/></label></div><Input placeholder="Comprovante ou observação" value={obs} onChange={e=>setObs(e.target.value)}/><Button disabled={salvando||valor<=0||valor>dados.saldo||!forma.trim()||!data||data>hoje()} onClick={()=>void pagar()}>Registrar pagamento da comissão</Button></fieldset>}
  </DialogContent></Dialog>;
}

function ParametrosDialog({parametros,isAdmin,onClose}:{parametros:Parametros;isAdmin:boolean;onClose:()=>void}) {
  const [p,setP]=useState<Parametros>({...parametros,tabelaTaxas:tabelaValida(parametros.tabelaTaxas)});const [busy,setBusy]=useState(false);const qc=useQueryClient();
  const taxas=p.tabelaTaxas??[];
  const setTaxa=(i:number,campo:'forma'|'percentual'|'fixo',v:string)=>setP(x=>({...x,tabelaTaxas:(x.tabelaTaxas??[]).map((t,k)=>k!==i?t:{...t,[campo]:campo==='forma'?v:Number(v)})}));
  const labels:Record<string,string>={impostoPct:'Impostos sobre venda (%)',custoFixoPct:'Rateio fixo (%)',garantiaPct:'Garantia (%)',custoPorKm:'Custo por km (R$)',alimentacaoDia:'Alimentação por dia (R$)',moAdminHora:'Hora administrativa (R$)',moAdminHorasPadrao:'Horas administrativas padrão',premiacaoPecaPct:'Premiação técnica de peças (%)',premiacaoServicoPct:'Premiação técnica de serviços (%)',cdbAnualPct:'Custo financeiro anual (%)'};
  return <Dialog open onOpenChange={onClose}><DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>Custos e regras de comissão</DialogTitle></DialogHeader><p className="text-sm">{parametros.origem}. A fórmula segue a análise do Pick & Pack. Os parâmetros abaixo são compartilhados nesta tela; ajustes posteriores no Pick & Pack precisam ser conferidos aqui. Valores de imposto são parâmetros gerenciais, não apuração fiscal.</p><fieldset disabled={!isAdmin||busy} className="space-y-4"><div className="grid sm:grid-cols-2 gap-3">{Object.entries(labels).map(([key,label])=><Numero key={key} label={label} value={p.config[key as keyof typeof p.config]} onChange={n=>setP(x=>({...x,config:{...x.config,[key]:n}}))}/>)}</div><label className="text-sm flex gap-2"><input type="checkbox" checked={p.margemAposComissao} onChange={e=>setP(x=>({...x,margemAposComissao:e.target.checked}))}/>Definir a faixa considerando a margem após descontar a própria comissão</label>
<div className="space-y-2 rounded-md border p-3">
  <h4 className="text-sm font-semibold">Taxas de recebimento estimadas</h4>
  <p className="text-xs text-muted-foreground">O lucro é calculado do recebível real. Quando o título no GC tem desconto, taxa de banco ou de operadora lançados, vale o lançado. Quando não tem, a taxa é estimada por esta tabela conforme a forma de pagamento — e a venda recebe um aviso pedindo o lançamento real no GC. A forma é comparada por trecho, sem acento.</p>
  <div className="grid grid-cols-[1fr_7rem_7rem_auto] items-end gap-2 text-xs">
    <span className="font-medium">Forma de pagamento contém</span><span className="font-medium">Percentual (%)</span><span className="font-medium">Fixo (R$)</span><span/>
    {taxas.map((t,i)=><Fragment key={i}>
      <Input value={t.forma} onChange={e=>setTaxa(i,'forma',e.target.value)} placeholder="CARTAO DE CREDITO"/>
      <Input type="number" step="0.01" min={0} max={99.99} value={t.percentual} onChange={e=>setTaxa(i,'percentual',e.target.value)}/>
      <Input type="number" step="0.01" min={0} value={t.fixo} onChange={e=>setTaxa(i,'fixo',e.target.value)}/>
      <Button type="button" variant="ghost" size="sm" onClick={()=>setP(x=>({...x,tabelaTaxas:(x.tabelaTaxas??[]).filter((_,k)=>k!==i)}))} aria-label="Remover linha">×</Button>
    </Fragment>)}
  </div>
  <Button type="button" variant="outline" size="sm" onClick={()=>setP(x=>({...x,tabelaTaxas:[...(x.tabelaTaxas??[]),{forma:'',percentual:0,fixo:0}]}))}>Adicionar forma</Button>
</div><p className="text-xs text-muted-foreground">Alterar parâmetros recalcula as previsões, inclusive vendas antigas. Os pagamentos registrados permanecem no histórico.</p><Button onClick={async()=>{setBusy(true);try{await salvarParametros({...p,origem:`Parâmetros conferidos no Command Center em ${dataBR(hoje())}`});await qc.invalidateQueries({queryKey:['comissoes']});onClose();toast.success('Parâmetros salvos.');}catch(e){toast.error((e as Error).message);}finally{setBusy(false);}}}>Salvar parâmetros</Button></fieldset></DialogContent></Dialog>;
}
