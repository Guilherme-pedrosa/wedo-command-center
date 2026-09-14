import {describe,it,expect} from 'vitest';
import {criarExcelComissoes} from './exportarExcel';
import {calcularVenda} from './calculo';
import {DEFAULT_ANALYSIS_CONFIG} from './analisePickPack';
import ExcelJS from 'exceljs';
describe('exportação Excel da conferência',()=>{
  it('preserva negativos como número, identificador como texto, datas e filtros após gravar e reabrir',async()=>{
    const r=calcularVenda({venda:{id:'1',codigo:'001234',data:'2026-09-10',valor_total:850,nome_cliente:'=1+1',nome_situacao:'Concretizada',gc_payload_raw:{nome_vendedor:'Guilherme',produtos:[{produto:{nome_produto:'Produto',quantidade:1,valor_total:850,valor_venda:850,valor_custo:900}}]}},recebimentos:[],pagamentos:[],conferencia:null},{config:DEFAULT_ANALYSIS_CONFIG,margemAposComissao:false,origem:'teste'});
    const w=await criarExcelComissoes([r],{inicio:'2026-09-01',fim:'2026-09-30',vendedores:['Guilherme'],situacoesGC:['Concretizada'],pagamentos:[],busca:''});
    const reaberto=new ExcelJS.Workbook();await reaberto.xlsx.load(await w.xlsx.writeBuffer());const s=reaberto.getWorksheet('Comissões')!;
    expect(s.getCell('B8').value).toBe('001234');expect(s.getCell('D8').value).toBe('=1+1');expect(s.getCell('D8').formula).toBeUndefined();
    expect(s.getCell('A8').value).toBeInstanceOf(Date);expect(typeof s.getCell('J8').value).toBe('number');expect(Number(s.getCell('J8').value)).toBeLessThan(0);expect(s.getCell('J8').numFmt).toContain('0.00%');
    expect(s.getCell('I8').value).toBe(Number((r.a.receitaLiquida-r.lucroAntes).toFixed(2)));
    expect(s.views[0]).toMatchObject({state:'frozen',xSplit:3,ySplit:7});expect(s.getTable('ConferenciaComissoes')).toBeTruthy();expect(String(s.getCell('A3').value)).toContain('Guilherme');
  });
  it('exporta comissão retirada, motivo e pagamentos preservados no detalhe e por vendedor',async()=>{
    const base={venda:{id:'retirada',codigo:'123',data:'2026-09-10',valor_total:100,nome_cliente:'Cliente',nome_situacao:'Concretizada',gc_payload_raw:{vendedor_id:'10',nome_vendedor:'Maria',produtos:[{produto:{nome_produto:'Produto',quantidade:1,valor_total:100,valor_venda:100,valor_custo:50}}]}},recebimentos:[],pagamentos:[{id:'p',venda_id:'retirada',valor:5,data_pagamento:'2026-09-12',forma_pagamento:'PIX',observacao:'Pago antes da retirada'}],conferencia:{venda_id:'retirada',ajustes:{},conferido:false,retirada:true,motivo_retirada:'Atendida pela gerência'}};
    const parametros={config:DEFAULT_ANALYSIS_CONFIG,margemAposComissao:false,origem:'teste'};
    const retirada=calcularVenda(base,parametros);
    const ativa=calcularVenda({...base,venda:{...base.venda,id:'ativa',codigo:'124'},pagamentos:[],conferencia:null},parametros);
    const homonima=calcularVenda({...base,venda:{...base.venda,id:'outra',codigo:'125',gc_payload_raw:{...base.venda.gc_payload_raw,vendedor_id:'20'}},pagamentos:[],conferencia:null},parametros);
    const original=await criarExcelComissoes([retirada,ativa,homonima],{inicio:'2026-09-01',fim:'2026-09-30',vendedores:[],situacoesGC:[],pagamentos:[],busca:''});
    const w=new ExcelJS.Workbook();await w.xlsx.load(await original.xlsx.writeBuffer());
    const detalhe=w.getWorksheet('Comissões')!;
    expect(detalhe.getCell('L8').value).toBe(0);expect(detalhe.getCell('Q8').value).toBe(5);expect(detalhe.getCell('R8').value).toBe(-5);
    expect(detalhe.getCell('W8').value).toBe(5);expect(detalhe.getCell('X8').value).toBe(5);expect(detalhe.getCell('Y8').value).toBe('Retirada');expect(detalhe.getCell('Z8').value).toBe('Atendida pela gerência');
    const resumo=w.getWorksheet('Por vendedor')!;
    expect(resumo.getCell('B5').value).toBe(2);expect(resumo.getCell('D5').value).toBe(10);expect(resumo.getCell('E5').value).toBe(5);expect(resumo.getCell('F5').value).toBe(5);expect(resumo.getCell('G5').value).toBe(5);
    expect(resumo.getCell('H5').value).toBe(5);expect(resumo.getCell('I5').value).toBe(5);expect(resumo.getCell('B6').value).toBe(1);
    expect(resumo.getCell('H5').numFmt).toContain('R$');expect(resumo.getTable('ResumoVendedores')).toBeTruthy();
  });

  it('separa frete cobrado, rateio adicional e custo já incluído no Excel',async()=>{
    const fonte={id:'compra:100',compraId:'100',compraCodigo:'45',descricao:'Entrega',fornecedor:'Transportadora',valor:60,pago:60,pagamentos:[{liquidado:true}],avisos:[],referenciasVendas:[],pedidosRelacionados:[],produtoIds:[]};
    const dados={venda:{id:'rateada',codigo:'1',data:'2026-09-10',valor_total:1000,nome_cliente:'Cliente',nome_situacao:'Concretizada',gc_payload_raw:{vendedor_id:'1',nome_vendedor:'Ana',valor_frete:100,produtos:[{produto:{nome_produto:'Produto',quantidade:1,valor_total:900,valor_venda:900,valor_custo:400}}]}},recebimentos:[],pagamentos:[],fretes:[fonte],conferencia:{venda_id:'rateada',ajustes:{fretes:[{fonteId:fonte.id,valor:30,limite:60,incluidoNoCusto:false,justificativa:'Metade da entrega'}]},conferido:false}};
    const parametros={config:{...DEFAULT_ANALYSIS_CONFIG,impostoPct:0},margemAposComissao:false,origem:'teste'};
    const adicional=calcularVenda(dados,parametros);
    const incluido=calcularVenda({...dados,venda:{...dados.venda,id:'incluida',codigo:'2'},conferencia:{...dados.conferencia,ajustes:{fretes:[{...dados.conferencia.ajustes.fretes[0],incluidoNoCusto:true}]}}},parametros);
    const pendente=calcularVenda({...dados,venda:{...dados.venda,id:'pendente',codigo:'3'},conferencia:null},parametros);
    const original=await criarExcelComissoes([adicional,incluido,pendente],{inicio:'2026-09-01',fim:'2026-09-30',vendedores:[],situacoesGC:[],pagamentos:[],busca:''});
    const w=new ExcelJS.Workbook();await w.xlsx.load(await original.xlsx.writeBuffer());const s=w.getWorksheet('Custos e fretes')!;
    expect(s.getCell('I5').value).toBe(30);expect(s.getCell('J5').value).toBe(0);expect(s.getCell('K5').value).toBe(430);expect(s.getCell('L5').value).toBe(100);
    expect(s.getCell('I6').value).toBe(0);expect(s.getCell('J6').value).toBe(30);expect(s.getCell('K6').value).toBe(400);expect(String(s.getCell('N6').value)).toContain('Já incluído');
    expect(s.getCell('I7').value).toBeNull();expect(s.getCell('J7').value).toBeNull();expect(s.getCell('M7').value).toContain('nenhum custo vinculado');expect(s.getCell('N5').value).toContain('Pedido 45');
    expect(s.getCell('N5').value).toContain('Baixa integral no GC');expect(s.getCell('N5').value).toContain('60,00');expect(s.getCell('U5').value).toBe(0);
    expect(s.getCell('I5').numFmt).toContain('R$');expect(s.getTable('CustosFretesComissoes')).toBeTruthy();
  });

});
