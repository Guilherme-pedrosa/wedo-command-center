import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function cleanDoc(d: string | null | undefined): string {
  return (d ?? "").replace(/\D/g, "");
}

function cnpjRaiz(doc: string): string {
  const clean = cleanDoc(doc);
  return clean.length >= 8 ? clean.substring(0, 8) : clean;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const { extrato_id, lancamento_ids, taxa_adiantamento_pct } = body as {
      extrato_id: string;
      lancamento_ids: string[];
      taxa_adiantamento_pct?: number; // e.g. 2.5 means 2.5%
    };

    if (!extrato_id || !lancamento_ids?.length) {
      return new Response(JSON.stringify({ success: false, error: "extrato_id e lancamento_ids são obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. Fetch extrato
    const { data: extrato, error: extErr } = await supabase
      .from("fin_extrato_inter")
      .select("*")
      .eq("id", extrato_id)
      .single();

    if (extErr || !extrato) {
      return new Response(JSON.stringify({ success: false, error: "Extrato não encontrado" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (extrato.reconciliado) {
      return new Response(JSON.stringify({ success: false, error: "Extrato já está conciliado" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isCredito = extrato.tipo === "CREDITO";
    const table = isCredito ? "fin_recebimentos" : "fin_pagamentos";
    const tabela = isCredito ? "recebimentos" : "pagamentos";
    const extValor = Math.abs(Number(extrato.valor));
    const extDoc = cleanDoc(extrato.cpf_cnpj);

    // 2. Fetch lancamentos
    const { data: lancamentos, error: lancErr } = await supabase
      .from(table)
      .select("id, valor, descricao, nome_cliente, nome_fornecedor, recipient_document, cliente_gc_id, fornecedor_gc_id, status, os_codigo, gc_codigo")
      .in("id", lancamento_ids);

    if (lancErr || !lancamentos?.length) {
      return new Response(JSON.stringify({ success: false, error: "Lançamentos não encontrados" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (lancamentos.length !== lancamento_ids.length) {
      return new Response(JSON.stringify({ success: false, error: `Esperava ${lancamento_ids.length} lançamentos, encontrou ${lancamentos.length}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Validate CNPJ raiz match (if extrato has doc)
    if (extDoc && extDoc.length >= 8) {
      const extRaiz = cnpjRaiz(extDoc);
      
      // Look up docs from clientes/fornecedores tables
      const gcIds = lancamentos.map((l: any) => isCredito ? l.cliente_gc_id : l.fornecedor_gc_id).filter(Boolean);
      let lookupDocs: Record<string, string> = {};
      
      if (gcIds.length > 0) {
        const lookupTable = isCredito ? "fin_clientes" : "fin_fornecedores";
        const { data: lookups } = await supabase
          .from(lookupTable)
          .select("gc_id, cpf_cnpj")
          .in("gc_id", gcIds);
        
        for (const l of (lookups || [])) {
          lookupDocs[l.gc_id] = cleanDoc(l.cpf_cnpj);
        }
      }

      for (const lanc of lancamentos) {
        const lancDoc = cleanDoc(lanc.recipient_document) || 
          lookupDocs[isCredito ? lanc.cliente_gc_id : lanc.fornecedor_gc_id] || "";
        
        if (lancDoc && lancDoc.length >= 8) {
          const lancRaiz = cnpjRaiz(lancDoc);
          if (extRaiz !== lancRaiz) {
            return new Response(JSON.stringify({
              success: false,
              error: `CNPJ raiz divergente: extrato ${extRaiz}... vs lançamento ${lanc.descricao} ${lancRaiz}...`,
            }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }
      }
    }

    // 4. Calculate sum and validate
    const somaLancamentos = lancamentos.reduce((s: number, l: any) => s + Math.abs(Number(l.valor)), 0);
    const diff = extValor - somaLancamentos; // positive = extrato > soma (has fee deducted)
    
    let valorJuros = 0;
    const hasTaxa = typeof taxa_adiantamento_pct === "number" && taxa_adiantamento_pct > 0;

    if (hasTaxa) {
      // User provided a fee rate — calculate expected deduction
      // The bank credits: somaLancamentos * (1 - taxa/100) = extValor
      // So: valorJuros = somaLancamentos - extValor
      valorJuros = somaLancamentos - extValor;
      
      if (valorJuros < 0) {
        return new Response(JSON.stringify({
          success: false,
          error: `Valor do extrato (${extValor.toFixed(2)}) é maior que a soma dos títulos (${somaLancamentos.toFixed(2)}). Taxa de adiantamento não se aplica.`,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Validate that the calculated fee roughly matches the provided percentage
      const pctCalculado = (valorJuros / somaLancamentos) * 100;
      if (Math.abs(pctCalculado - taxa_adiantamento_pct) > 1.0) {
        // More than 1 percentage point off — warn but proceed
        console.warn(`Taxa informada ${taxa_adiantamento_pct}% vs calculada ${pctCalculado.toFixed(2)}%`);
      }
    } else {
      // No fee — require exact match (tolerance R$0.01)
      if (Math.abs(diff) > 0.01) {
        return new Response(JSON.stringify({
          success: false,
          error: `Soma (R$ ${somaLancamentos.toFixed(2)}) ≠ extrato (R$ ${extValor.toFixed(2)}). Diferença: R$ ${Math.abs(diff).toFixed(2)}. Se há taxa de adiantamento, informe o percentual.`,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    const now = new Date().toISOString();
    const maior = lancamentos.reduce((a: any, b: any) => Math.abs(Number(a.valor)) > Math.abs(Number(b.valor)) ? a : b);

    // 5. Mark extrato as reconciled
    const { error: updExtErr } = await supabase.from("fin_extrato_inter").update({
      reconciliado: true,
      reconciliado_em: now,
      reconciliation_rule: "MANUAL_SOMA",
      lancamento_id: maior.id,
    }).eq("id", extrato_id);

    if (updExtErr) throw new Error(`Erro atualizar extrato: ${updExtErr.message}`);

    // 6. Insert N:N links
    const rows = lancamentos.map((l: any) => ({
      extrato_id,
      lancamento_id: l.id,
      tabela,
      valor_alocado: Math.abs(Number(l.valor)),
      reconciliation_rule: "MANUAL_SOMA",
    }));

    const { error: linkErr } = await supabase.from("fin_extrato_lancamentos")
      .upsert(rows, { onConflict: "extrato_id,lancamento_id,tabela" });

    if (linkErr) {
      // Rollback extrato
      await supabase.from("fin_extrato_inter").update({
        reconciliado: false, reconciliado_em: null, reconciliation_rule: null, lancamento_id: null,
      }).eq("id", extrato_id);
      throw new Error(`Erro inserir links: ${linkErr.message}`);
    }

    // 7. Mark each lancamento as pago
    for (const l of lancamentos) {
      await supabase.from(table).update({
        pago_sistema: true,
        pago_sistema_em: now,
        status: "pago",
      }).eq("id", l.id);
    }

    // 8. If there's a fee, create a juros entry in fin_pagamentos
    let jurosId: string | null = null;
    if (hasTaxa && valorJuros > 0.01) {
      const nomeContraparte = extrato.nome_contraparte || extrato.contrapartida || "—";
      const osCodigos = lancamentos.map((l: any) => l.os_codigo).filter(Boolean).join(", ");
      
      const { data: jurosEntry, error: jurosErr } = await supabase.from("fin_pagamentos").insert({
        descricao: `Juros adiantamento ${nomeContraparte}${osCodigos ? ` (OS: ${osCodigos})` : ""}`,
        valor: valorJuros,
        data_emissao: extrato.data_hora?.substring(0, 10) || now.substring(0, 10),
        data_vencimento: extrato.data_hora?.substring(0, 10) || now.substring(0, 10),
        data_competencia: extrato.data_hora?.substring(0, 10) || now.substring(0, 10),
        status: "pago",
        pago_sistema: true,
        pago_sistema_em: now,
        tipo: "juros_adiantamento",
        origem: "manual",
        nome_fornecedor: nomeContraparte,
        observacao: `Taxa ${taxa_adiantamento_pct}% sobre R$ ${somaLancamentos.toFixed(2)} = R$ ${valorJuros.toFixed(2)}. Extrato: ${extrato_id}`,
      }).select("id").single();

      if (jurosErr) {
        console.error("Erro ao criar lançamento de juros:", jurosErr.message);
      } else {
        jurosId = jurosEntry?.id || null;
        
        // Also link the juros entry to the extrato for full traceability
        if (jurosId) {
          await supabase.from("fin_extrato_lancamentos").upsert({
            extrato_id,
            lancamento_id: jurosId,
            tabela: "pagamentos",
            valor_alocado: valorJuros,
            reconciliation_rule: "MANUAL_SOMA_JUROS",
          }, { onConflict: "extrato_id,lancamento_id,tabela" });
        }
      }
    }

    // 9. Log
    await supabase.from("fin_sync_log").insert({
      tipo: "conciliacao_manual_soma",
      referencia_id: extrato_id,
      status: "success",
      payload: {
        extrato_id,
        lancamento_ids: lancamentos.map((l: any) => l.id),
        soma: somaLancamentos,
        valor_extrato: extValor,
        taxa_adiantamento_pct: taxa_adiantamento_pct || null,
        valor_juros: valorJuros || null,
        juros_id: jurosId,
      },
    });

    return new Response(JSON.stringify({
      success: true,
      conciliados: lancamentos.length,
      soma: somaLancamentos,
      valor_extrato: extValor,
      diferenca: Math.abs(diff),
      juros: valorJuros > 0.01 ? { id: jurosId, valor: valorJuros, taxa: taxa_adiantamento_pct } : null,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("manual-reconcile-batch error:", err);
    return new Response(JSON.stringify({ success: false, error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
