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
});
