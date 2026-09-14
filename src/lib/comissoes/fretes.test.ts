import {describe,it,expect} from 'vitest';
import {analisarFretes,indiciosFrete} from './fretes';
const compra=(patch:Record<string,any>={})=>({gc_id:'15050798',codigo:'4684',gc_payload_raw:{Compra:{id:'15050798',codigo:'4684',valor_frete:'0',produtos:[{produto:{produto_id:'97114094',nome_produto:'MINI CAMARA',valor_total:'5439.46'}}],pagamentos:[{pagamento:{observacao:'Frete mandala kofisa',valor:'756.86'}}],...patch}}});
const titulo={gc_id:'594191926',descricao:'Compra de nº 4684 - FRETE MINI CÂMARA KOFISA',valor:'756.86',liquidado:true};
const entregaSavoy={gc_id:'593814263',gc_codigo:'41621',descricao:'Compra de nº 4673 - REEMSOLSO ANGELICA - OS 6449 ENTREGA LIXEIRAS MARIANA',nome_fornecedor:'LSA TRANSPORTES LTDA',valor:'230.00',liquidado:true,data_vencimento:'2026-08-19',data_liquidacao:'2026-08-19'};
const vendaSavoy={codigo:'1773530751',gc_payload_raw:{atributos:[{atributo:{descricao:'NÚMERO DO ORÇAMENTO',conteudo:'6449',id:'59216864'}}]}};
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
  it('encontra o reembolso real da entrega das lixeiras pelo fornecedor e operação',()=>{
    const [f]=analisarFretes([],[entregaSavoy]);
    expect(f.id).toBe('pagamento:593814263');expect(f.compraCodigo).toBe('4673');
    expect(f.valor).toBe(230);expect(f.pago).toBe(230);expect(f.pagamentos).toEqual([entregaSavoy]);
    expect(f.referenciasVendas).toEqual([]);
    expect(indiciosFrete(f,vendaSavoy)).toEqual(['Número do orçamento citado no frete: confirmar vínculo com esta venda']);
  });
  it('não considera qualquer pagamento a transportadora nem qualquer reembolso como frete',()=>{
    expect(analisarFretes([], [
      {...entregaSavoy,descricao:'Compra de nº 4673'},
      {...entregaSavoy,nome_fornecedor:'LOJA DE MATERIAIS LTDA'},
      {...entregaSavoy,nome_fornecedor:'TRANSPORTELETRICA LTDA'},
    ])).toEqual([]);
  });
  it('reconhece logística acentuada, reembolso e o erro de escrita existente no GC',()=>{
    for(const observacao of ['COLETA DOS ITENS','REEMBOLSO ANGELICA','REEMSOLSO ANGELICA']) {
      const [f]=analisarFretes([],[{...entregaSavoy,descricao:observacao,nome_fornecedor:undefined,gc_payload_raw:{nome_fornecedor:'EMPRESA LOGÍSTICA LTDA'}}]);
      expect(f.valor).toBe(230);
    }
  });
  it('consolida o título de entrega na fonte do pedido quando o pedido está sincronizado',()=>{
    const c={gc_id:'15040000',codigo:'4673',gc_payload_raw:{Compra:{valor_frete:'0',produtos:[],pagamentos:[]}}};
    const fontes=analisarFretes([c],[entregaSavoy]);
    expect(fontes).toHaveLength(1);expect(fontes[0].id).toBe('compra:15040000');
    expect(fontes[0].valor).toBe(230);expect(fontes[0].pago).toBe(230);
    expect(indiciosFrete(fontes[0],vendaSavoy)[0]).toContain('confirmar vínculo');
  });
  it('não confunde orçamento com código da venda, id de atributo ou número parecido',()=>{
    const [f]=analisarFretes([],[entregaSavoy]);
    expect(indiciosFrete(f,{codigo:'6449'})).toEqual([]);
    for(const atributo of [
      {descricao:'NÚMERO DO ORÇAMENTO',conteudo:'64490',id:'6449'},
      {descricao:'NÚMERO DO ORÇAMENTO',conteudo:'16449'},
      {descricao:'OS GC',conteudo:'6449'},
      {descricao:'NÚMERO DO ORÇAMENTO',conteudo:'6449 / 9999'},
    ]) expect(indiciosFrete(f,{gc_payload_raw:{id:'6449',atributos:[{atributo}]}})).toEqual([]);
    expect(indiciosFrete({...f,descricao:'',pagamentos:[{...entregaSavoy,descricao:'ENTREGA OS 64490'}]},vendaSavoy)).toEqual([]);
  });
  it('normaliza referências rotuladas de orçamento sem exigir zeros à esquerda',()=>{
    const [f]=analisarFretes([],[{...entregaSavoy,descricao:'Reembolso entrega Orçamento nº 006449'}]);
    const venda={gc_payload_raw:{atributos:[{descricao:'Número do orçamento',conteudo:'OR 6449'}]}};
    expect(indiciosFrete(f,venda)[0]).toContain('confirmar vínculo');
  });
});
