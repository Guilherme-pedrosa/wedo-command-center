import {describe,it,expect} from 'vitest';
import {analisarFretes,indiciosFrete} from './fretes';
const compra=(patch:Record<string,any>={})=>({gc_id:'15050798',codigo:'4684',gc_payload_raw:{Compra:{id:'15050798',codigo:'4684',valor_frete:'0',produtos:[{produto:{produto_id:'97114094',nome_produto:'MINI CAMARA',valor_total:'5439.46'}}],pagamentos:[{pagamento:{observacao:'Frete mandala kofisa',valor:'756.86'}}],...patch}}});
const titulo={gc_id:'594191926',descricao:'Compra de nº 4684 - FRETE MINI CÂMARA KOFISA',valor:'756.86',liquidado:true};
describe('fretes em compras e pagamentos',()=>{
  it('encontra frete pago com cabeçalho zerado e não soma parcela prevista novamente',()=>{
    const [f]=analisarFretes([compra()],[titulo]);expect(f.valor).toBe(756.86);expect(f.pago).toBe(756.86);expect(f.avisos).toEqual([]);
  });
  it('identifica o título atual sem frete na descrição pela parcela exata do pedido',()=>{
    const c=compra({pagamentos:[{pagamento:{observacao:'Frete mandala kofisa',valor:'756.86',data_vencimento:'2026-09-01'}}]});
    const [f]=analisarFretes([c],[{...titulo,gc_id:'599081401',descricao:'Compra de nº 4684',data_vencimento:'2026-09-01'}]);
    expect(f.pago).toBe(756.86);expect(f.pagamentos[0].gc_id).toBe('599081401');
  });
  it('deduplica cabeçalho, parcela e título como uma única fonte',()=>{
    const [f]=analisarFretes([compra({valor_frete:'756.86'})],[titulo]);expect(f.valor).toBe(756.86);
  });
  it('não confunde títulos com mesmo valor: sinaliza possível duplicidade',()=>{
    const [f]=analisarFretes([compra()],[titulo,{...titulo,gc_id:'outro'}]);expect(f.pagamentos).toHaveLength(2);expect(f.valor).toBe(756.86);expect(f.pago).toBe(1513.72);expect(f.avisos.join()).toContain('possível duplicidade');
  });
  it('identifica venda na descrição de pagamento sem pedido sincronizado',()=>{
    const [f]=analisarFretes([],[{...titulo,descricao:'Compra de nº 4670 - FRETE (FRETE PARA COLETA DA MAQUINA A VACUO DO PEDIDO DE VENDA - 1773530725)',valor:'300'}]);
    expect(f.valor).toBe(300);expect(f.referenciasVendas).toEqual(['1773530725']);expect(indiciosFrete(f,{codigo:'1773530725'})).toHaveLength(1);expect(indiciosFrete(f,{codigo:'17735307250'})).toEqual([]);
  });
  it('mesmo produto é indício, não vínculo automático',()=>{
    const [f]=analisarFretes([compra()],[titulo]);expect(indiciosFrete(f,{codigo:'1',gc_payload_raw:{produtos:[{produto:{produto_id:'97114094'}}]}})[0]).toContain('confirmar');
  });
  it('mantém pedidos compartilhados e custo total sem multiplicar por destinos',()=>{
    const [f]=analisarFretes([compra({campos_extras:[{extras:{descricao:'Frete - Pedidos de Compras das peças deste Frete',conteudo:'4713,4714'}}]})],[titulo]);expect(f.pedidosRelacionados).toEqual(['4713','4714']);expect(f.valor).toBe(756.86);
  });
  it('segue o pedido de mercadorias referenciado pelo serviço de frete',()=>{
    const transporte=compra({produtos:[],campos_extras:[{extras:{descricao:'Frete - Pedidos de Compras das peças deste Frete',conteudo:'4713'}}]});
    const mercadoria={gc_id:'20',codigo:'4713',gc_payload_raw:{Compra:{produtos:[{produto:{produto_id:'peca'}}]}}};
    const [f]=analisarFretes([transporte,mercadoria],[titulo]);expect(f.produtoIds).toContain('peca');
  });
});
