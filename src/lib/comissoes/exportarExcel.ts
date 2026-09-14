import type { calcularVenda } from './calculo';
import { centavos } from './calculo';

type Linha=ReturnType<typeof calcularVenda>;
export interface FiltrosExcel { inicio:string; fim:string; vendedores:string[]; situacoesGC:string[]; pagamentos:string[]; busca:string }

export async function criarExcelComissoes(linhas: Linha[], filtros: FiltrosExcel) {
  const {default:ExcelJS}=await import('exceljs');
  const workbook=new ExcelJS.Workbook();
  workbook.creator='WeDo Command Center';
  workbook.created=new Date();
  workbook.calcProperties.fullCalcOnLoad=true;
  const sheet=workbook.addWorksheet('Comissões',{views:[{state:'frozen',xSplit:3,ySplit:7,showGridLines:false}]});
  const cabecalhos=['Data da venda','Venda GC','Vendedor','Cliente','Situação no GC','Produtos vendidos','Valor da venda','Base de produtos','Custos antes da comissão','Margem antes da comissão','Alíquota de comissão','Comissão devida','Margem final','Recebido do cliente','Situação do pagamento','Forma de pagamento','Comissão paga registrada','Saldo da comissão','Conferência','Pendências','Custo dos produtos no GC','Impostos e demais despesas','Comissão calculada','Comissão retirada','Situação da comissão','Motivo da retirada'];
  const larguras=[15,19,27,43,30,58,20,20,23,20,20,22,18,22,34,30,24,22,24,58,24,28,22,22,24,60];
  sheet.columns=larguras.map(width=>({width}));
  sheet.mergeCells('A1:Z1');sheet.getCell('A1').value='WeDo · Conferência de comissões';
  sheet.getCell('A1').font={name:'Calibri',size:18,bold:true,color:{argb:'FFFFFFFF'}};
  sheet.getCell('A1').fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF17263D'}};sheet.getRow(1).height=36;
  const br=(d:string)=>d.split('-').reverse().join('/');
  sheet.mergeCells('A2:Z2');sheet.getCell('A2').value=`Vendas de ${br(filtros.inicio)} a ${br(filtros.fim)} · ${linhas.length} venda(s) · Exportado em ${new Date().toLocaleString('pt-BR')}`;
  sheet.mergeCells('A3:Z3');sheet.getCell('A3').value=`Vendedores: ${filtros.vendedores.join(', ')||'Todos'}. Situações GC: ${filtros.situacoesGC.join(', ')||'Todas'}. Pagamento/conferência: ${filtros.pagamentos.join(', ')||'Todos'}. Busca: ${filtros.busca||'Nenhuma'}.`;
  sheet.getRow(3).height=32;sheet.getCell('A3').alignment={wrapText:true,vertical:'middle'};
  sheet.mergeCells('A4:Z4');sheet.getCell('A4').value='Recebido do cliente = baixa no GC. Comissão paga = registro no Command Center. Custos pendentes deixam a margem sem valor.';
  sheet.getRow(4).height=25;
  const moeda='"R$" #,##0.00;[Red]("R$" #,##0.00)';
  const dinheiro=[7,8,9,12,14,17,18,21,22,23,24];
  const percentuais=[10,11,13];
  sheet.addTable({name:'ConferenciaComissoes',ref:'A7',headerRow:true,totalsRow:true,style:{theme:'TableStyleMedium2',showRowStripes:true},
    columns:cabecalhos.map((name,i)=>({name,filterButton:true,...(i===0?{totalsRowLabel:'TOTAL VISÍVEL'}:dinheiro.includes(i+1)?{totalsRowFunction:'sum' as const}:{})})),
    rows:linhas.map(r=>[
      new Date(`${r.venda.data}T12:00:00Z`),String(r.venda.codigo),r.vendedor||'Não informado',String(r.venda.nome_cliente||''),String(r.venda.nome_situacao||''),
      r.a.linhas.filter(l=>l.tipo==='produto').map(l=>`${l.quantidade} × ${l.nome}`).join('\n'),
      centavos(r.a.receitaLiquida),r.base,centavos(r.a.receitaLiquida-r.lucroAntes),r.margemAntes===null?null:r.margemAntes/100,r.percentual/100,r.comissao,r.margemFinal===null?null:r.margemFinal/100,
      r.recebimentos.length?r.recebido:null,r.recebimento,r.formas.join(' / '),r.pagamentos.length?r.pago:null,r.saldo,r.conferidaAtual?'Conferida':'A conferir',r.avisos.join('\n'),centavos(r.a.custoProdutos),centavos(r.a.receitaLiquida-r.lucroAntes-r.a.custoProdutos-r.a.custoServicos),r.comissaoCalculada,r.comissaoRetirada,r.retirada?'Retirada':'Ativa',r.conferencia?.motivo_retirada||''
    ])});
  sheet.getRow(7).height=42;
  sheet.getRow(7).eachCell(cell=>{cell.font={name:'Calibri',size:11,bold:true,color:{argb:'FFFFFFFF'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF24476A'}};cell.alignment={wrapText:true,vertical:'middle'};});
  for(let n=8;n<=8+linhas.length;n++) {
    const row=sheet.getRow(n);row.height=n===8+linhas.length?27:Math.max(45,16*Math.max(...[4,5,6,15,16,20,26].map(c=>String(row.getCell(c).value||'').split('\n').reduce((a,t)=>a+Math.max(1,Math.ceil(t.length/(larguras[c-1]-3))),0))));
    row.eachCell(cell=>{cell.font={name:'Calibri',size:11};cell.alignment={vertical:'top',wrapText:true};});
    row.getCell(1).numFmt='dd/mm/yyyy';
    dinheiro.forEach(c=>{row.getCell(c).numFmt=moeda;row.getCell(c).alignment={horizontal:'right',vertical:'top'};});
    percentuais.forEach(c=>{row.getCell(c).numFmt='0.00%;[Red](0.00%)';row.getCell(c).alignment={horizontal:'right',vertical:'top'};});
    if(n<8+linhas.length&&linhas[n-8].avisos.length)row.getCell(20).font={name:'Calibri',size:11,color:{argb:'FF9A5200'}};
  }
  const resumo=workbook.addWorksheet('Por vendedor',{views:[{state:'frozen',ySplit:4,showGridLines:false}]});
  resumo.columns=[30,16,22,22,22,22,22,22,24].map(width=>({width}));
  resumo.mergeCells('A1:I1');resumo.getCell('A1').value='WeDo · Comissões por vendedor';resumo.getCell('A1').font={bold:true,size:18};resumo.getRow(1).height=32;
  resumo.mergeCells('A2:I2');resumo.getCell('A2').value=`Vendas de ${br(filtros.inicio)} a ${br(filtros.fim)}. Mesmos filtros da aba Comissões.`;
  const grupos=new Map<string,{nome:string;quantidade:number;vendas:number;calculada:number;retirada:number;devida:number;paga:number;saldo:number;ajuste:number}>();
  for(const r of linhas){const g=grupos.get(r.vendedorChave)??{nome:r.vendedor||'Não informado',quantidade:0,vendas:0,calculada:0,retirada:0,devida:0,paga:0,saldo:0,ajuste:0};g.quantidade++;g.vendas+=r.a.receitaLiquida;g.calculada+=r.comissaoCalculada;g.retirada+=r.comissaoRetirada;g.devida+=r.comissao;g.paga+=r.pago;g.saldo+=Math.max(0,r.saldo);g.ajuste+=Math.max(0,-r.saldo);grupos.set(r.vendedorChave,g);}
  resumo.addTable({name:'ResumoVendedores',ref:'A4',headerRow:true,totalsRow:true,style:{theme:'TableStyleMedium2',showRowStripes:true},columns:['Vendedor','Vendas','Valor vendido','Comissão calculada','Comissão retirada','Comissão devida','Comissão paga','Saldo a pagar','Pago acima do devido'].map((name,i)=>({name,filterButton:true,...(i?{totalsRowFunction:'sum' as const}:{totalsRowLabel:'TOTAL VISÍVEL'})})),rows:[...grupos.values()].sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR')).map(g=>[g.nome,g.quantidade,...[g.vendas,g.calculada,g.retirada,g.devida,g.paga,g.saldo,g.ajuste].map(centavos)])});
  resumo.getRow(4).height=40;resumo.getRow(4).alignment={wrapText:true,vertical:'middle'};
  for(let row=5;row<=5+grupos.size;row++){resumo.getRow(row).height=28;for(let col=3;col<=9;col++)resumo.getCell(row,col).numFmt=moeda;}
  return workbook;
}

export async function exportarExcel(linhas:Linha[],filtros:FiltrosExcel) {
  const workbook=await criarExcelComissoes(linhas,filtros);
  const bytes=await workbook.xlsx.writeBuffer();
  const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  const link=document.createElement('a');link.href=url;link.download=`comissoes-${filtros.inicio}-a-${filtros.fim}.xlsx`;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
