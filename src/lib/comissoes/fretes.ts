import { parseMoney } from './analisePickPack';
import type { Registro } from './calculo';

export interface RateioFrete { fonteId: string; valor: number; limite: number; incluidoNoCusto: boolean; justificativa: string }
export interface FonteFrete {
  id: string; compraCodigo: string; compraId: string; descricao: string; fornecedor: string;
  valor: number; pago: number; pagamentos: Registro[]; avisos: string[]; referenciasVendas: string[];
  pedidosRelacionados: string[]; produtoIds: string[]; atualizadoEm?: string;
}
const moeda = (n:number) => Math.round((n+Number.EPSILON)*100)/100;
const frete = (s:unknown) => /frete|transporte(?: de carga)?|carreto/i.test(String(s??''));
const normalizar = (s:unknown) => String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const transportador = (s:unknown) => /\b(?:transportes?|transportadoras?|logistica|logistic|carretos?|fretes?)\b/.test(normalizar(s));
// O fornecedor sozinho não comprova frete: exigir também a operação descrita.
const pagamentoDeFrete = (p:Registro) => frete(p.descricao) || (
  transportador(p.nome_fornecedor??p.gc_payload_raw?.nome_fornecedor)
  && /\b(?:entrega|coleta|reembolso|reemsolso)\b/.test(normalizar(p.descricao))
);
const rawCompra = (r:Registro) => r.gc_payload_raw?.Compra??r.gc_payload_raw??r;
const valorPagamento = (r:Registro) => parseMoney(r.gc_payload_raw?.valor_total??r.valor_total??r.valor);
const codigoCompra = (r:Registro) => String(r.descricao??'').match(/\bcompra\s+de\s+n[^0-9]*([0-9]+)/i)?.[1];
const referencias = (texto:string) => [...new Set([...texto.matchAll(/\bvenda(?:\s+de)?(?:\s+n[ºo°.]*)?\s*[-:#]?\s*(\d+)/gi)].map(m=>m[1]))];

// Uma fonte por pedido: cabeçalho, parcela prevista e título são evidências do
// mesmo frete, não três despesas. Títulos distintos nunca são apagados por terem valor igual.
export function analisarFretes(compras:Registro[], pagamentos:Registro[]):FonteFrete[] {
  const usados = new Set<string>();
  const resultado:FonteFrete[]=[];
  for (const compra of compras) {
    const c=rawCompra(compra), codigo=String(compra.codigo??c.codigo), id=String(compra.gc_id??c.id);
    const itens=[...(c.produtos??[]).map((p:Registro)=>p.produto??p),...(c.servicos??[]).map((s:Registro)=>s.servico??s)];
    const transporteIntegral=itens.length>0&&itens.every((i:Registro)=>frete(i.nome_produto??i.nome_servico));
    const parcelas=(c.pagamentos??[]).map((p:Registro)=>p.pagamento??p);
    const campos=(c.campos_extras??[]).map((p:Registro)=>p.extras??p);
    const previstos=parcelas.filter((p:Registro)=>frete(p.observacao)).reduce((s:number,p:Registro)=>s+parseMoney(p.valor),0);
    const cabecalho=parseMoney(c.valor_frete);
    const itensFrete=itens.filter((i:Registro)=>frete(i.nome_produto??i.nome_servico)).reduce((s:number,i:Registro)=>s+parseMoney(i.valor_total),0);
    const relacionados=pagamentos.filter(p=>codigoCompra(p)===codigo);
    const titulos=relacionados.filter(p=>transporteIntegral||pagamentoDeFrete(p)||(
      // A listagem da API omite a observação da parcela. Exigir a parcela de
      // frete com valor/data exatos e um único título correspondente.
      parcelas.some((parcela:Registro)=>frete(parcela.observacao)&&Math.abs(parseMoney(parcela.valor)-valorPagamento(p))<0.01&&parcela.data_vencimento===p.data_vencimento&&relacionados.filter(outro=>Math.abs(valorPagamento(outro)-valorPagamento(p))<0.01&&outro.data_vencimento===p.data_vencimento).length===1)
    ));
    const financeiro=titulos.reduce((s,p)=>s+valorPagamento(p),0);
    if (!(cabecalho||previstos||itensFrete||financeiro)) continue;
    const avisos:string[]=[];
    const evidencias=[cabecalho,previstos,itensFrete].filter(n=>n>0);
    const valor=moeda(Math.max(...evidencias,0)||financeiro);
    if (evidencias.some(n=>Math.abs(n-valor)>0.02)) avisos.push('Valores de frete divergentes dentro do pedido');
    if (titulos.length&&Math.abs(financeiro-valor)>0.02) avisos.push('Financeiro do frete difere do pedido; conferir títulos e possível duplicidade');
    if (!titulos.length) avisos.push('Pagamento do frete ainda não localizado');
    titulos.forEach(p=>usados.add(String(p.gc_id)));
    const descricao=[c.observacoes_interna,...parcelas.map((p:Registro)=>p.observacao),...itens.filter((i:Registro)=>frete(i.nome_produto??i.nome_servico)).map((i:Registro)=>i.nome_produto??i.nome_servico)].filter(Boolean).join(' · ');
    resultado.push({id:`compra:${id}`,compraCodigo:codigo,compraId:id,descricao,fornecedor:c.nome_fornecedor??compra.nome_fornecedor,valor,pago:moeda(titulos.filter(p=>p.liquidado===true).reduce((s,p)=>s+valorPagamento(p),0)),pagamentos:titulos,avisos,referenciasVendas:referencias([descricao,...titulos.map(p=>p.descricao)].join(' ')),pedidosRelacionados:campos.filter((p:Registro)=>/frete.*pedidos.*compras/i.test(p.descricao)).flatMap((p:Registro)=>String(p.conteudo).match(/\d+/g)??[]),produtoIds:itens.map((p:Registro)=>String(p.produto_id??'')).filter(Boolean),atualizadoEm:compra.last_synced_at});
  }
  for (const p of pagamentos) {
    if (usados.has(String(p.gc_id))||!pagamentoDeFrete(p)) continue;
    resultado.push({id:`pagamento:${p.gc_id}`,compraCodigo:codigoCompra(p)??'',compraId:'',descricao:p.descricao,fornecedor:p.nome_fornecedor,valor:valorPagamento(p),pago:p.liquidado===true?valorPagamento(p):0,pagamentos:[p],avisos:['Pedido de compra não localizado na consulta; conferir origem'],referenciasVendas:referencias(p.descricao),pedidosRelacionados:[],produtoIds:[],atualizadoEm:p.last_synced_at});
  }
  for(const f of resultado) {
    // Serviços de transporte podem apontar para os pedidos das mercadorias.
    const ids=compras.filter(c=>f.pedidosRelacionados.includes(String(c.codigo??rawCompra(c).codigo)))
      .flatMap(c=>(rawCompra(c).produtos??[]).map((p:Registro)=>String((p.produto??p).produto_id??''))).filter(Boolean);
    f.produtoIds=[...new Set([...f.produtoIds,...ids])];
  }
  return resultado;
}

export function indiciosFrete(f:FonteFrete,venda:Registro):string[] {
  if (f.referenciasVendas.includes(String(venda.codigo))) return ['Código da venda na descrição do frete'];
  const numero = (s:string) => s.replace(/^0+(?=\d)/,'');
  const orcamentos=(venda.gc_payload_raw?.atributos??[]).map((a:Registro)=>a.atributo??a)
    .filter((a:Registro)=>/\borcamento\b/.test(normalizar(a.descricao)))
    .map((a:Registro)=>normalizar(a.conteudo).trim().match(/^(?:(?:orcamento|or)\s*)?(?:n(?:umero|[ºo°.])?\s*)?[-:#]?\s*(\d+)$/)?.[1])
    .filter(Boolean).map(numero);
  // "OS" na descrição pode referir-se ao orçamento. Exigir o atributo da
  // venda e o número completo; continua sendo indício sujeito a conferência.
  const texto=normalizar([f.descricao,...f.pagamentos.map(p=>p.descricao)].join(' '));
  const referenciasOrcamento=[...texto.matchAll(/\b(?:o\.?\s*s\.?|orcamento|or)\s*(?:n(?:umero|[ºo°.])?\s*)?[-:#]?\s*(\d+)\b/g)].map(m=>numero(m[1]));
  if(orcamentos.some((n:string)=>referenciasOrcamento.includes(n))) return ['Número do orçamento citado no frete: confirmar vínculo com esta venda'];
  const ids=(venda.gc_payload_raw?.produtos??[]).map((p:Registro)=>String((p.produto??p).produto_id??''));
  return f.produtoIds.some(id=>ids.includes(id))?['Mesmo produto no pedido; confirmar quantidade e destino']:[];
}
