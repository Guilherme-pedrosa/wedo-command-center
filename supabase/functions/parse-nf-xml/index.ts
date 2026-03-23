import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Simple XML tag extractor (no external deps)
function getTag(xml: string, tag: string): string {
  // Try with namespace prefix first, then without
  for (const t of [tag]) {
    const patterns = [
      new RegExp(`<(?:[a-zA-Z0-9]+:)?${t}[^>]*>([^<]*)<\\/(?:[a-zA-Z0-9]+:)?${t}>`, "i"),
      new RegExp(`<${t}[^>]*>([^<]*)<\\/${t}>`, "i"),
    ];
    for (const re of patterns) {
      const m = xml.match(re);
      if (m?.[1]?.trim()) return m[1].trim();
    }
  }
  return "";
}

function getBlock(xml: string, tag: string): string {
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${tag}>`, "i");
  const m = xml.match(re);
  return m?.[1] ?? "";
}

interface NfData {
  tipo: "nfe" | "nfse" | "nfce" | "desconhecido";
  numero: string;
  serie: string;
  data_emissao: string;
  // Emitente
  emit_cnpj: string;
  emit_razao: string;
  emit_fantasia: string;
  // Destinatário / Tomador
  dest_cnpj: string;
  dest_cpf: string;
  dest_razao: string;
  // Valores
  valor_total: number;
  valor_servicos: number;
  valor_produtos: number;
  valor_deducoes: number;
  valor_iss: number;
  valor_ir: number;
  valor_pis: number;
  valor_cofins: number;
  valor_csll: number;
  valor_inss: number;
  valor_liquido: number;
  // Chave
  chave_acesso: string;
}

function parseNFe(xml: string): NfData {
  const infNFe = getBlock(xml, "infNFe") || xml;
  const ide = getBlock(infNFe, "ide");
  const emit = getBlock(infNFe, "emit");
  const dest = getBlock(infNFe, "dest");
  const total = getBlock(infNFe, "total");
  const icmsTot = getBlock(total, "ICMSTot");

  // Chave de acesso from infNFe Id attribute
  const chaveMatch = xml.match(/Id="NFe(\d{44})"/i) || xml.match(/chNFe>(\d{44})</i);
  
  const vNF = parseFloat(getTag(icmsTot, "vNF")) || 0;
  const vProd = parseFloat(getTag(icmsTot, "vProd")) || 0;
  const vIR = parseFloat(getTag(icmsTot, "vIRRF") || getTag(xml, "vIRRF")) || 0;
  const vPIS = parseFloat(getTag(icmsTot, "vPIS")) || 0;
  const vCOFINS = parseFloat(getTag(icmsTot, "vCOFINS")) || 0;
  const vCSLL = parseFloat(getTag(xml, "vCSLL")) || 0;
  const vINSS = parseFloat(getTag(xml, "vINSS")) || 0;
  const vISS = parseFloat(getTag(icmsTot, "vISS") || getTag(xml, "vISS")) || 0;
  const retencoes = vIR + vPIS + vCOFINS + vCSLL + vINSS + vISS;

  return {
    tipo: xml.includes("<NFe") || xml.includes("<nfeProc") ? "nfe" : "nfce",
    numero: getTag(ide, "nNF"),
    serie: getTag(ide, "serie"),
    data_emissao: getTag(ide, "dhEmi") || getTag(ide, "dEmi"),
    emit_cnpj: getTag(emit, "CNPJ"),
    emit_razao: getTag(emit, "xNome"),
    emit_fantasia: getTag(emit, "xFant"),
    dest_cnpj: getTag(dest, "CNPJ"),
    dest_cpf: getTag(dest, "CPF"),
    dest_razao: getTag(dest, "xNome"),
    valor_total: vNF,
    valor_servicos: 0,
    valor_produtos: vProd,
    valor_deducoes: retencoes,
    valor_iss: vISS,
    valor_ir: vIR,
    valor_pis: vPIS,
    valor_cofins: vCOFINS,
    valor_csll: vCSLL,
    valor_inss: vINSS,
    valor_liquido: vNF - retencoes,
    chave_acesso: chaveMatch?.[1] || "",
  };
}

function parseNFSe(xml: string): NfData {
  // NFS-e pode ter vários formatos (ABRASF, Ginfes, etc.)
  const infNfse = getBlock(xml, "InfNfse") || getBlock(xml, "Nfse") || xml;
  const servico = getBlock(infNfse, "Servico") || getBlock(infNfse, "DadosServico") || infNfse;
  const valores = getBlock(servico, "Valores") || servico;
  const tomador = getBlock(infNfse, "TomadorServico") || getBlock(infNfse, "Tomador") || "";
  const prestador = getBlock(infNfse, "PrestadorServico") || getBlock(infNfse, "Prestador") || "";
  const identTomador = getBlock(tomador, "IdentificacaoTomador") || getBlock(tomador, "CpfCnpj") || tomador;
  const identPrestador = getBlock(prestador, "IdentificacaoPrestador") || getBlock(prestador, "CpfCnpj") || prestador;

  const valorServicos = parseFloat(getTag(valores, "ValorServicos")) || 0;
  const valorDeducoes = parseFloat(getTag(valores, "ValorDeducoes")) || 0;
  const valorIss = parseFloat(getTag(valores, "ValorIss") || getTag(valores, "ValorISSRetido")) || 0;
  const valorIr = parseFloat(getTag(valores, "ValorIr")) || 0;
  const valorPis = parseFloat(getTag(valores, "ValorPis")) || 0;
  const valorCofins = parseFloat(getTag(valores, "ValorCofins")) || 0;
  const valorCsll = parseFloat(getTag(valores, "ValorCsll")) || 0;
  const valorInss = parseFloat(getTag(valores, "ValorInss")) || 0;
  const valorLiquidoTag = parseFloat(getTag(valores, "ValorLiquidoNfse")) || 0;
  
  const retencoes = valorIr + valorPis + valorCofins + valorCsll + valorInss + (parseFloat(getTag(valores, "IssRetido")) === 1 ? valorIss : 0);
  const valorLiquido = valorLiquidoTag || (valorServicos - valorDeducoes - retencoes);

  return {
    tipo: "nfse",
    numero: getTag(infNfse, "Numero"),
    serie: getTag(infNfse, "Serie") || "",
    data_emissao: getTag(infNfse, "DataEmissao") || getTag(infNfse, "dhEmi") || "",
    emit_cnpj: getTag(identPrestador, "Cnpj") || getTag(identPrestador, "CNPJ") || "",
    emit_razao: getTag(prestador, "RazaoSocial") || getTag(prestador, "xNome") || "",
    emit_fantasia: getTag(prestador, "NomeFantasia") || "",
    dest_cnpj: getTag(identTomador, "Cnpj") || getTag(identTomador, "CNPJ") || "",
    dest_cpf: getTag(identTomador, "Cpf") || getTag(identTomador, "CPF") || "",
    dest_razao: getTag(tomador, "RazaoSocial") || getTag(tomador, "xNome") || "",
    valor_total: valorServicos,
    valor_servicos: valorServicos,
    valor_produtos: 0,
    valor_deducoes: valorDeducoes,
    valor_iss: valorIss,
    valor_ir: valorIr,
    valor_pis: valorPis,
    valor_cofins: valorCofins,
    valor_csll: valorCsll,
    valor_inss: valorInss,
    valor_liquido: valorLiquido,
    chave_acesso: "",
  };
}

function detectAndParse(xml: string): NfData {
  // Detect NF type
  if (xml.includes("<NFe") || xml.includes("<nfeProc") || xml.includes("<infNFe")) {
    return parseNFe(xml);
  }
  if (xml.includes("<Nfse") || xml.includes("<InfNfse") || xml.includes("<CompNfse") || xml.includes("<ListaNfse") || xml.includes("<ConsultarNfse")) {
    return parseNFSe(xml);
  }
  // Try NF-e as fallback
  if (xml.includes("<nNF>")) return parseNFe(xml);
  if (xml.includes("<ValorServicos>")) return parseNFSe(xml);
  
  return { ...parseNFe(xml), tipo: "desconhecido" };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { xml_content, grupo_id, file_path } = await req.json();

    if (!xml_content) {
      return new Response(JSON.stringify({ error: "xml_content obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const nf = detectAndParse(xml_content);

    // If grupo_id provided, validate against group data
    let validacao: { valido: boolean; erros: string[]; avisos: string[] } | null = null;

    if (grupo_id) {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );

      const { data: grupo, error: gErr } = await supabase
        .from("fin_grupos_receber")
        .select("*, fin_grupo_receber_itens(recebimento_id, valor, fin_recebimentos(cliente_gc_id, nome_cliente, recipient_document))")
        .eq("id", grupo_id)
        .single();

      if (gErr || !grupo) {
        return new Response(JSON.stringify({ error: "Grupo não encontrado" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const erros: string[] = [];
      const avisos: string[] = [];
      const valorGrupo = Number(grupo.valor_total) || 0;

      // ── Valor validation ──
      // Permitir pequena tolerância de arredondamento entre NF e grupo
      const valorTolerance = 1.0;
      // Primary check: valor_total (gross) must match group value
      // Retained taxes don't change the receivable amount
      if (Math.abs(nf.valor_total - valorGrupo) <= valorTolerance) {
        // Total matches — if there are deductions, just inform
        if (nf.valor_deducoes > 0) {
          avisos.push(`NF possui retenções de R$ ${nf.valor_deducoes.toFixed(2)} (IR: ${nf.valor_ir.toFixed(2)}, ISS: ${nf.valor_iss.toFixed(2)}, PIS: ${nf.valor_pis.toFixed(2)}, COFINS: ${nf.valor_cofins.toFixed(2)}, CSLL: ${nf.valor_csll.toFixed(2)}, INSS: ${nf.valor_inss.toFixed(2)}). Líquido: R$ ${nf.valor_liquido.toFixed(2)}`);
        }
      } else if (nf.valor_liquido > 0 && Math.abs(nf.valor_liquido - valorGrupo) <= valorTolerance) {
        // Líquido matches — group may have been created with net value
        avisos.push(`Valor líquido da NF (R$ ${nf.valor_liquido.toFixed(2)}) confere, mas o total bruto é R$ ${nf.valor_total.toFixed(2)} (retenções: R$ ${nf.valor_deducoes.toFixed(2)})`);
      } else {
        erros.push(`Valor da NF (total: R$ ${nf.valor_total.toFixed(2)}, líquido: R$ ${nf.valor_liquido.toFixed(2)}) não confere com o grupo (R$ ${valorGrupo.toFixed(2)})`);
      }

      // ── Cliente/CNPJ validation ──
      // Collect all CNPJ/CPF from group items
      const docsGrupo = new Set<string>();
      const nomesGrupo = new Set<string>();
      if (grupo.nome_cliente) nomesGrupo.add(grupo.nome_cliente.toLowerCase().trim());
      
      for (const item of (grupo.fin_grupo_receber_itens || [])) {
        const rec = item.fin_recebimentos;
        if (rec?.recipient_document) docsGrupo.add(rec.recipient_document.replace(/[^\d]/g, ""));
        if (rec?.nome_cliente) nomesGrupo.add(rec.nome_cliente.toLowerCase().trim());
      }

      const nfDoc = (nf.dest_cnpj || nf.dest_cpf).replace(/[^\d]/g, "");
      const nfNome = nf.dest_razao.toLowerCase().trim();

      if (nfDoc && docsGrupo.size > 0) {
        if (!docsGrupo.has(nfDoc)) {
          erros.push(`CNPJ/CPF do destinatário da NF (${nfDoc}) não confere com nenhum cliente do grupo`);
        }
      } else if (nfNome && nomesGrupo.size > 0) {
        const nomeConfere = [...nomesGrupo].some(n => n.includes(nfNome) || nfNome.includes(n));
        if (!nomeConfere) {
          erros.push(`Destinatário da NF ("${nf.dest_razao}") não confere com o cliente do grupo ("${grupo.nome_cliente || "—"}")`);
        }
      } else if (!nfDoc && !nfNome) {
        avisos.push("Não foi possível identificar o destinatário/tomador no XML da NF");
      }

      validacao = { valido: erros.length === 0, erros, avisos };

      // If valid and file_path provided, log in sync_log
      if (erros.length === 0 && file_path) {
        await supabase.from("fin_sync_log").insert({
          tipo: "nf_xml_validacao",
          status: "ok",
          referencia_id: grupo_id,
          payload: { nf_numero: nf.numero, nf_tipo: nf.tipo, file_path },
          resposta: { validacao, nf_resumo: { valor_total: nf.valor_total, valor_liquido: nf.valor_liquido, dest_razao: nf.dest_razao } },
        });
      }
    }

    return new Response(
      JSON.stringify({ nf, validacao }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[parse-nf-xml] ERRO:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
