import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatBRL } from '@/lib/comissoes/analisePickPack';
import { indiciosFrete, type FonteFrete, type RateioFrete } from '@/lib/comissoes/fretes';
import type { Registro } from '@/lib/comissoes/calculo';

export function FretesComissoes({fontes,rateios,venda,selecionados=[],onChange}:{fontes:FonteFrete[];rateios:Registro[];venda?:Registro;selecionados?:RateioFrete[];onChange?:(r:RateioFrete[])=>void}) {
  const [busca,setBusca]=useState('');
  const [limite,setLimite]=useState(15);
  const linhas=fontes.filter(f=>`${f.compraCodigo} ${f.descricao} ${f.fornecedor} ${f.referenciasVendas.join(' ')}`.toLowerCase().includes(busca.toLowerCase()))
    .sort((a,b)=>Number(!!venda&&indiciosFrete(b,venda).length>0)-Number(!!venda&&indiciosFrete(a,venda).length>0));
  return <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">Fretes e pedidos de compra — {fontes.length} fonte(s) localizada(s)</summary>
    <p className="text-xs text-muted-foreground my-2">Consulta inclui frete no cabeçalho, nas parcelas e no financeiro, mesmo fora do período da venda. Baixado no GC não significa conciliação bancária. Conferir divergências e ratear somente o custo desta venda.</p>
    <Input aria-label="Buscar frete ou pedido" placeholder="Pedido, transportadora, descrição ou venda…" value={busca} onChange={e=>{setBusca(e.target.value);setLimite(15);}}/>
    {linhas.slice(0,limite).map(f=>{
      const escolhido=selecionados.find(r=>r.fonteId===f.id);
      const usado=rateios.filter(r=>r.venda_id!==venda?.id).flatMap(r=>r.fretes??[]).filter(r=>r.fonteId===f.id).reduce((s,r)=>s+Number(r.valor),0);
      const saldo=Math.max(0,Math.round((f.valor-usado)*100)/100);
      const mudar=(patch:Partial<RateioFrete>)=>onChange?.(selecionados.map(r=>r.fonteId===f.id?{...r,...patch}:r));
      return <div className="border-t mt-3 pt-3 space-y-2 text-sm" key={f.id}>
        <p className="font-medium">Pedido {f.compraCodigo||'não localizado'} · {f.fornecedor} · {formatBRL(f.valor)}</p>
        <p>{f.descricao}</p><p>Baixado no GC: {formatBRL(f.pago)} · {f.pagamentos.length} título(s) · Disponível para rateio: {formatBRL(saldo)}</p>
        {f.pedidosRelacionados.length>0&&<p>Pedidos transportados: {f.pedidosRelacionados.join(', ')}</p>}
        {venda&&indiciosFrete(f,venda).map(s=><p className="text-primary" key={s}>{s}</p>)}
        {f.avisos.map(s=><p className="text-amber-500" key={s}>{s}</p>)}
        <details><summary className="cursor-pointer">Ver títulos e datas</summary>{f.pagamentos.map(p=><p key={p.gc_id}><a className="text-primary underline" target="_blank" rel="noreferrer" href={`https://gestaoclick.com/financeiro/movimentacoes_financeiras/visualizar_pagamento/${encodeURIComponent(p.gc_id)}`}>#{p.gc_codigo??p.gc_id}</a> · {formatBRL(Number(p.gc_payload_raw?.valor_total??p.valor_total??p.valor))} · {p.liquidado?'Baixado':'Em aberto'} · {p.data_liquidacao||p.data_vencimento} · {p.nome_fornecedor} · {p.descricao}</p>)}</details>
        {onChange&&(escolhido?<div className="grid gap-2 sm:grid-cols-2"><label>Valor atribuído a esta venda<Input type="number" min="0" max={saldo} step="0.01" value={escolhido.valor} onChange={e=>mudar({valor:Number(e.target.value)})}/></label><label>Justificativa do vínculo / rateio<Input value={escolhido.justificativa} onChange={e=>mudar({justificativa:e.target.value})}/></label><label className="flex gap-2 items-center"><input type="checkbox" checked={escolhido.incluidoNoCusto} onChange={e=>mudar({incluidoNoCusto:e.target.checked})}/>Já incluído no custo dos produtos no GC</label><Button variant="outline" onClick={()=>onChange(selecionados.filter(r=>r.fonteId!==f.id))}>Remover vínculo desta venda</Button></div>:<Button variant="outline" size="sm" disabled={saldo<=0} onClick={()=>onChange([...selecionados,{fonteId:f.id,valor:saldo,limite:f.valor,incluidoNoCusto:false,justificativa:''}])}>Conferir e ratear nesta venda</Button>)}
      </div>;
    })}
    {!linhas.length&&<p className="py-3">Nenhuma fonte encontrada.</p>}
    {linhas.length>limite&&<Button variant="outline" className="mt-3" onClick={()=>setLimite(n=>n+30)}>Mostrar mais ({linhas.length-limite})</Button>}
  </details>;
}
