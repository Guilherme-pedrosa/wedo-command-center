import type { DadosVenda, Registro } from './calculo';

export type Consulta = (request: { endpoint: string; params: Record<string,string> }) => Promise<{status:number;data:any}>;

export async function buscarPagamentosGC(consultar:Consulta, progresso?:(n:number,total:number)=>void):Promise<Registro[]> {
  return buscarColecaoFinanceira('/api/pagamentos',consultar,progresso);
}

async function buscarColecaoFinanceira(endpoint:string,consultar:Consulta,progresso?:(n:number,total:number)=>void):Promise<Registro[]> {
  const encontrados=new Map<string,Registro>();
  for(let pagina=1;pagina<=500;pagina++) {
    const request={endpoint,params:{limite:'100',pagina:String(pagina)}};
    let resposta=await consultar(request);
    for(let tentativa=0;resposta.status===429&&tentativa<2;tentativa++){
      await new Promise(resolve=>setTimeout(resolve,1000*(tentativa+1)));resposta=await consultar(request);
    }
    const payload=resposta.data,total=Number(payload?.meta?.total_paginas);
    if(resposta.status<200||resposta.status>=300||!Array.isArray(payload?.data)||!Number.isInteger(total)||total<0||total>500)throw new Error('Consulta dos pagamentos incompleta no GC');
    for(const raw of payload.data) {
      if(!raw.id)throw new Error('Pagamento sem identidade no GC');
      encontrados.set(String(raw.id),{...raw,gc_id:String(raw.id),gc_codigo:raw.codigo,gc_payload_raw:raw,liquidado:raw.liquidado===true||raw.liquidado==='1'||raw.liquidado===1});
    }
    progresso?.(pagina,total);
    if(pagina>=total){if(Number(payload.meta.total_registros)!==encontrados.size)throw new Error('Quantidade de pagamentos incompleta');return [...encontrados.values()];}
    if(!payload.data.length)throw new Error('Página vazia antes do fim dos pagamentos');
  }
  throw new Error('Limite de consulta dos pagamentos excedido');
}

// O período pertence à VENDA. Não limitar os vencimentos dos títulos ao mês selecionado.
export async function buscarTitulosCliente(cliente: string, consultar: Consulta): Promise<Registro[]> {
  const encontrados = new Map<string,Registro>();
  for (let pagina=1; pagina<=100; pagina++) {
    const request={endpoint:'/api/recebimentos',params:{cliente_id:cliente,limite:'100',pagina:String(pagina)}};
    let resposta=await consultar(request);
    for(let tentativa=0;resposta.status===429&&tentativa<2;tentativa++) {
      await new Promise(resolve=>setTimeout(resolve,1000*(tentativa+1)));
      resposta=await consultar(request);
    }
    const payload=resposta.data;
    if (resposta.status<200 || resposta.status>=300 || !Array.isArray(payload?.data)) throw new Error('Consulta financeira incompleta no GC');
    const totalPaginas=Number(payload.meta?.total_paginas);
    if (!Number.isInteger(totalPaginas) || totalPaginas<0 || totalPaginas>100) throw new Error('Paginação financeira não confirmada');
    for (const raw of payload.data) {
      if (!raw.id || String(raw.cliente_id)!==cliente) throw new Error('Identidade do recebimento divergente');
      encontrados.set(String(raw.id),{...raw,id:String(raw.id),gc_id:String(raw.id),gc_codigo:raw.codigo,gc_payload_raw:raw,liquidado:raw.liquidado===true||raw.liquidado==='1'||raw.liquidado===1});
    }
    if (pagina>=totalPaginas) {
      const total=Number(payload.meta?.total_registros);
      if (!Number.isInteger(total) || total<0 || total!==encontrados.size) throw new Error('Quantidade de títulos incompleta');
      return [...encontrados.values()];
    }
    if (!payload.data.length) throw new Error('Página financeira vazia antes do fim');
  }
  throw new Error('Consulta financeira excedeu o limite de páginas');
}

export function vincularTitulos(venda: Registro, titulos: Registro[], vendasCliente: Registro[]) {
  return titulos.filter(r=>{
    const raw=r.gc_payload_raw??r;
    if (raw.venda_id) return String(raw.venda_id)===String(venda.gc_id);
    // O GC permite faturar a venda para outra unidade. Exigir unicidade global,
    // confirmada pelo banco, antes de vincular pelo código em outro cliente.
    if (String(r.cliente_id)!==String(venda.cliente_id) && venda.codigo_unico!==true) return false;
    const codigo=String(r.descricao??'').match(/\bvenda\s+de\s+n[^0-9]*([0-9]+)/i)?.[1];
    return venda.codigo_unico!==false && !!codigo && codigo===String(venda.codigo) && vendasCliente.filter(v=>String(v.codigo)===codigo).length===1;
  });
}

export async function conferirFinanceiroGC(vendas: DadosVenda[], consultar: Consulta, progresso?: (concluidos:number,total:number)=>void) {
  const clientes=[...new Set(vendas.map(v=>String(v.venda.cliente_id||'')).filter(Boolean))];
  let proximo=0,concluidos=0;
  const resultado=vendas.map(v=>({...v,consultaFinanceira:'pendente' as 'gc'|'pendente'}));
  progresso?.(0,clientes.length);
  async function trabalhar() {
    while(proximo<clientes.length) {
      const cliente=clientes[proximo++];
      const grupo=resultado.filter(v=>String(v.venda.cliente_id)===cliente);
      try {
        const titulos=await buscarTitulosCliente(cliente,consultar);
        for(const v of grupo) {
          const outros = v.recebimentos.filter(r=>String(r.cliente_id)!==cliente);
          const atualizados: Registro[] = [];
          for (const anterior of outros) {
            const resposta=await consultar({endpoint:`/api/recebimentos/${encodeURIComponent(anterior.gc_id)}`,params:{}});
            const raw=resposta.data?.data?.data??resposta.data?.data??resposta.data;
            if(resposta.status<200||resposta.status>=300||String(raw?.id)!==String(anterior.gc_id)) throw new Error('Não foi possível atualizar título faturado em outro cliente');
            atualizados.push({...raw,gc_id:String(raw.id),gc_codigo:raw.codigo,gc_payload_raw:raw,liquidado:raw.liquidado===true||raw.liquidado==='1'||raw.liquidado===1});
          }
          v.recebimentos=vincularTitulos(v.venda,[...titulos,...atualizados],resultado.map(g=>g.venda));
          v.consultaFinanceira='gc';
        }
      } catch {
        // Preserve a última leitura e sinalize a falha. Nunca transformar falha em "sem financeiro".
        for(const v of grupo) v.consultaFinanceira='pendente';
      }
      progresso?.(++concluidos,clientes.length);
    }
  }
  await Promise.all([trabalhar(),trabalhar()]);
  const semTitulos=resultado.filter(v=>v.consultaFinanceira==='gc'&&!v.recebimentos.length);
  if(semTitulos.length){
    // Uma cobrança nova em outra unidade pode ainda não estar no cache.
    // A ausência só é confirmada depois de consultar a coleção completa.
    try{
      const globais=await buscarColecaoFinanceira('/api/recebimentos',consultar);
      for(const v of semTitulos)v.recebimentos=vincularTitulos(v.venda,globais,resultado.map(r=>r.venda));
    }catch{for(const v of semTitulos)v.consultaFinanceira='pendente';}
  }
  return resultado;
}
