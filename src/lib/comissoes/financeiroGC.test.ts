import {describe,it,expect,vi} from 'vitest';
import {buscarTitulosCliente,vincularTitulos,conferirFinanceiroGC,buscarPagamentosGC} from './financeiroGC';
import type {DadosVenda} from './calculo';
const venda={gc_id:'397877670',codigo:'1773530806',cliente_id:'61816409'};
const raw={id:'601354220',cliente_id:'61816409',descricao:'Venda de nº 1773530806 (1/6)',valor:'298.08',data_vencimento:'2027-01-03',liquidado:'0'};
const periodo={data_inicio:'2000-01-01',data_fim:'2100-12-31'};
describe('conferência dos títulos diretamente no GC',()=>{
  it('Villa Andorinhas: busca o título pago em agosto de uma venda de julho, fora do mês atual do GC',async()=>{
    const villa={gc_id:'388171696',codigo:'1773530705',cliente_id:'49132537',codigo_unico:true};
    const titulo={id:'587580801',cliente_id:villa.cliente_id,descricao:'Venda de nº 1773530705',valor:'105.63',valor_total:'105.63',data_vencimento:'2026-08-20',data_liquidacao:'2026-08-20',liquidado:'1'};
    // Resposta real observada: sem datas o GC retorna somente setembro e omite o título.
    const consultar=vi.fn(async(q)=>({status:200,data:q.params.data_inicio==='2000-01-01'&&q.params.data_fim==='2100-12-31'
      ?{data:[titulo],meta:{total_paginas:1,total_registros:1}}
      :{data:[],meta:{total_paginas:null,total_registros:null},message:'Nenhuma movimentação foi encontrada!'}}));
    const [r]=await conferirFinanceiroGC([{venda:villa,recebimentos:[],conferencia:null,pagamentos:[]}],consultar);
    expect(r.recebimentos.map(t=>t.gc_id)).toEqual(['587580801']);expect(r.recebimentos[0].liquidado).toBe(true);expect(r.consultaFinanceira).toBe('gc');
  });
  it('confirma por ID um título do mesmo cliente omitido pela listagem',async()=>{
    const anterior={...raw,gc_id:raw.id};
    const consultar=vi.fn().mockResolvedValueOnce({status:200,data:{data:[],meta:{total_paginas:0,total_registros:0}}}).mockResolvedValueOnce({status:200,data:{data:{...raw,liquidado:'1'}}});
    const [r]=await conferirFinanceiroGC([{venda,recebimentos:[anterior],conferencia:null,pagamentos:[]}],consultar);
    expect(consultar.mock.calls[1][0].endpoint).toBe(`/api/recebimentos/${raw.id}`);expect(r.recebimentos).toHaveLength(1);expect(r.recebimentos[0].liquidado).toBe(true);
  });
  it('preserva título e sinaliza pendência se a confirmação por ID falhar',async()=>{
    const anterior={...raw,gc_id:raw.id};
    const consultar=vi.fn().mockResolvedValueOnce({status:200,data:{data:[],meta:{total_paginas:0,total_registros:0}}}).mockResolvedValueOnce({status:503,data:{}});
    const [r]=await conferirFinanceiroGC([{venda,recebimentos:[anterior],conferencia:null,pagamentos:[]}],consultar);
    expect(r.recebimentos).toEqual([anterior]);expect(r.consultaFinanceira).toBe('pendente');
  });
  it('encontra cobrança nova em outra unidade mesmo sem vínculo no cache',async()=>{
    const consultar=vi.fn().mockResolvedValueOnce({status:200,data:{data:[],meta:{total_paginas:0,total_registros:0}}}).mockResolvedValueOnce({status:200,data:{data:[{...raw,cliente_id:'outra'}],meta:{total_paginas:1,total_registros:1}}});
    const [r]=await conferirFinanceiroGC([{venda:{...venda,codigo_unico:true},recebimentos:[],conferencia:null,pagamentos:[]}],consultar);
    expect(r.recebimentos).toHaveLength(1);expect(r.consultaFinanceira).toBe('gc');expect(consultar.mock.calls[1][0].params).not.toHaveProperty('cliente_id');
  });
  it('lê pagamentos fora do período da venda e rejeita lista truncada',async()=>{
    const consultar=vi.fn().mockResolvedValue({status:200,data:{data:[raw],meta:{total_paginas:1,total_registros:1}}});
    expect(await buscarPagamentosGC(consultar)).toHaveLength(1);expect(consultar.mock.calls[0][0].params).toEqual({...periodo,limite:'100',pagina:'1'});
    await expect(buscarPagamentosGC(async()=>({status:200,data:{data:[raw],meta:{total_paginas:1,total_registros:2}}}))).rejects.toThrow('incompleta');
  });
  it('reconsulta o título faturado em outra unidade pelo ID',async()=>{
    const outro={...raw,cliente_id:'outra',gc_id:raw.id};
    const consultar=vi.fn().mockResolvedValueOnce({status:200,data:{data:[],meta:{total_paginas:0,total_registros:0}}}).mockResolvedValueOnce({status:200,data:{data:outro}});
    const [r]=await conferirFinanceiroGC([{venda:{...venda,codigo_unico:true},recebimentos:[outro],conferencia:null,pagamentos:[]}],consultar);
    expect(r.consultaFinanceira).toBe('gc');expect(r.recebimentos).toHaveLength(1);expect(consultar.mock.calls[1][0].endpoint).toBe(`/api/recebimentos/${raw.id}`);
  });
  it('aceita cobrança em outras unidades apenas com código globalmente único',()=>{
    const outro={...raw,cliente_id:'outra-unidade'};
    expect(vincularTitulos({...venda,codigo_unico:true},[outro],[venda])).toEqual([outro]);
    expect(vincularTitulos({...venda,codigo_unico:false},[outro],[venda])).toEqual([]);
  });
  it('busca todas as páginas por cliente, sem limitar vencimento ou liquidação',async()=>{
    const consultar=vi.fn().mockResolvedValueOnce({status:200,data:{data:[raw],meta:{total_paginas:2,total_registros:2}}}).mockResolvedValueOnce({status:200,data:{data:[{...raw,id:'outro',liquidado:'1'}],meta:{total_paginas:2,total_registros:2}}});
    const titulos=await buscarTitulosCliente('61816409',consultar);
    expect(consultar.mock.calls.map(([q])=>q.params)).toEqual([{...periodo,cliente_id:'61816409',limite:'100',pagina:'1'},{...periodo,cliente_id:'61816409',limite:'100',pagina:'2'}]);
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
