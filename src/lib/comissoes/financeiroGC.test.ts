import {describe,it,expect,vi} from 'vitest';
import {buscarTitulosCliente,vincularTitulos,conferirFinanceiroGC} from './financeiroGC';
import type {DadosVenda} from './calculo';
const venda={gc_id:'397877670',codigo:'1773530806',cliente_id:'61816409'};
const raw={id:'601354220',cliente_id:'61816409',descricao:'Venda de nº 1773530806 (1/6)',valor:'298.08',data_vencimento:'2027-01-03',liquidado:'0'};
describe('conferência dos títulos diretamente no GC',()=>{
  it('busca todas as páginas por cliente, sem limitar vencimento ou liquidação',async()=>{
    const consultar=vi.fn().mockResolvedValueOnce({status:200,data:{data:[raw],meta:{total_paginas:2,total_registros:2}}}).mockResolvedValueOnce({status:200,data:{data:[{...raw,id:'outro',liquidado:'1'}],meta:{total_paginas:2,total_registros:2}}});
    const titulos=await buscarTitulosCliente('61816409',consultar);
    expect(consultar.mock.calls.map(([q])=>q.params)).toEqual([{cliente_id:'61816409',limite:'100',pagina:'1'},{cliente_id:'61816409',limite:'100',pagina:'2'}]);
    expect(titulos.map(t=>t.liquidado)).toEqual([false,true]);expect(vincularTitulos(venda,titulos,[venda])).toHaveLength(2);
  });
  it('não confunde vendas com prefixo igual, outros clientes ou identidade explícita diferente',()=>{
    const candidatos=[raw,{...raw,descricao:'Venda de nº 17735308060'},{...raw,cliente_id:'outro'},{...raw,venda_id:'outra'}];
    expect(vincularTitulos(venda,candidatos,[venda])).toEqual([raw]);
    expect(vincularTitulos(venda,[raw],[venda,{...venda,gc_id:'duplicada'}])).toEqual([]);
  });
  it('preserva leitura anterior quando consulta retorna erro, não inventa lista vazia',async()=>{
    const dados:DadosVenda={venda,recebimentos:[raw],conferencia:null,pagamentos:[]};
    const resultado=await conferirFinanceiroGC([dados],async()=>({status:503,data:{}}));
    expect(resultado[0].recebimentos).toEqual([raw]);expect(resultado[0].consultaFinanceira).toBe('pendente');
  });
  it('rejeita página truncada ou filtro por cliente ignorado',async()=>{
    await expect(buscarTitulosCliente('61816409',async()=>({status:200,data:{data:[raw],meta:{total_paginas:1,total_registros:6}}}))).rejects.toThrow('incompleta');
    await expect(buscarTitulosCliente('outro',async()=>({status:200,data:{data:[raw],meta:{total_paginas:1,total_registros:1}}}))).rejects.toThrow('divergente');
  });
});
