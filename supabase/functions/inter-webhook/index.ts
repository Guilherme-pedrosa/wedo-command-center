import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const logBase = {
    tipo: "inter_webhook",
    payload: body,
    created_at: new Date().toISOString(),
  };

  try {
    // ━━━ PIX RECEBIDO (crédito) ━━━
    if (body.pix && Array.isArray(body.pix)) {
      for (const pix of body.pix) {
        const { txid, endToEndId, valor, horario, pagador } = pix;
        const valorNum = parseFloat(valor ?? "0");
        const dataHora = horario ?? new Date().toISOString();

        // 1. Gravar no extrato local
        await supabase.from("fin_extrato_inter").upsert(
          {
            end_to_end_id: endToEndId ?? txid,
            tipo: "CREDITO",
            valor: valorNum,
            data_hora: dataHora,
            contrapartida: pagador?.nome ?? "",
            cpf_cnpj: pagador?.cnpj ?? pagador?.cpf ?? "",
            chave_pix: pix.chave ?? null,
            payload_raw: pix,
          },
          { onConflict: "end_to_end_id", ignoreDuplicates: true }
        );

        // 2. Buscar grupo pelo txid
        let grupoId: string | null = null;

        const { data: grupoPorTxid } = await supabase
          .from("fin_grupos_receber")
          .select("id, nome, valor_total, nome_cliente, status")
          .eq("inter_txid", txid)
          .neq("status", "pago")
          .maybeSingle();

        if (grupoPorTxid) {
          grupoId = grupoPorTxid.id;
        } else {
          // 3. Match por valor + nome cliente
          const { data: grupos } = await supabase
            .from("fin_grupos_receber")
            .select("id, valor_total, nome_cliente, status")
            .in("status", ["aberto", "aguardando_pagamento"]);

          const match = grupos?.find((g: any) => {
            const diff = Math.abs(
              parseFloat(String(g.valor_total)) - valorNum
            );
            const nomeOk = pagador?.nome
              ? g.nome_cliente
                  ?.toLowerCase()
                  .includes(pagador.nome.toLowerCase().substring(0, 6))
              : false;
            return diff <= 0.01 && nomeOk;
          });
          if (match) grupoId = match.id;
        }

        if (grupoId) {
          // 4. Atualizar grupo (NÃO baixar no GC)
          await supabase
            .from("fin_grupos_receber")
            .update({
              status: "aguardando_pagamento",
              inter_pago_em: dataHora,
              inter_pagador: pagador?.nome ?? "",
              valor_recebido: valorNum,
              updated_at: new Date().toISOString(),
            })
            .eq("id", grupoId);

          // 5. Reconciliar extrato
          await supabase
            .from("fin_extrato_inter")
            .update({
              reconciliado: true,
              grupo_receber_id: grupoId,
              reconciliado_em: new Date().toISOString(),
            })
            .eq("end_to_end_id", endToEndId ?? txid);

          // 6. Marcar recebimentos como pago_sistema
          const { data: itens } = await supabase
            .from("fin_grupo_receber_itens")
            .select("recebimento_id")
            .eq("grupo_id", grupoId);

          if (itens?.length) {
            await supabase
              .from("fin_recebimentos")
              .update({
                pago_sistema: true,
                pago_sistema_em: dataHora,
              })
              .in(
                "id",
                itens.map((i: any) => i.recebimento_id)
              );
          }

          await supabase.from("fin_sync_log").insert({
            ...logBase,
            tipo: "inter_webhook_recebimento",
            referencia_id: grupoId,
            status: "pendente_aprovacao",
            resposta: {
              txid,
              valor: valorNum,
              grupo_id: grupoId,
              mensagem:
                "PIX recebido. Aguardando aprovação do usuário para baixa no GC.",
            },
          });
        } else {
          await supabase.from("fin_sync_log").insert({
            ...logBase,
            tipo: "inter_webhook_sem_match",
            status: "pendente_aprovacao",
            resposta: {
              txid,
              valor: valorNum,
              pagador,
              mensagem: "PIX recebido sem grupo correspondente.",
            },
          });
        }
      }
    }

    // ━━━ PIX ENVIADO (débito) ━━━
    if (body.tipo === "PAGAMENTO" || body.endToEndId) {
      const { endToEndId, valor, horario, favorecido } = body;
      const valorNum = parseFloat(valor ?? "0");
      const dataHora = horario ?? new Date().toISOString();

      await supabase.from("fin_extrato_inter").upsert(
        {
          end_to_end_id: endToEndId,
          tipo: "DEBITO",
          valor: valorNum,
          data_hora: dataHora,
          contrapartida: favorecido?.nome ?? "",
          cpf_cnpj: favorecido?.cnpj ?? favorecido?.cpf ?? "",
          chave_pix: body.chave ?? null,
          payload_raw: body,
        },
        { onConflict: "end_to_end_id", ignoreDuplicates: true }
      );

      const { data: grupoPagar } = await supabase
        .from("fin_grupos_pagar")
        .select("id, status")
        .eq("inter_pagamento_id", endToEndId)
        .maybeSingle();

      if (grupoPagar) {
        await supabase
          .from("fin_grupos_pagar")
          .update({
            status: "aguardando_pagamento",
            inter_pago_em: dataHora,
            inter_favorecido: favorecido?.nome ?? "",
            valor_pago: valorNum,
            updated_at: new Date().toISOString(),
          })
          .eq("id", grupoPagar.id);

        const { data: itensPagar } = await supabase
          .from("fin_grupo_pagar_itens")
          .select("pagamento_id")
          .eq("grupo_id", grupoPagar.id);

        if (itensPagar?.length) {
          await supabase
            .from("fin_pagamentos")
            .update({
              pago_sistema: true,
              pago_sistema_em: dataHora,
            })
            .in(
              "id",
              itensPagar.map((i: any) => i.pagamento_id)
            );
        }

        await supabase
          .from("fin_extrato_inter")
          .update({
            reconciliado: true,
            grupo_pagar_id: grupoPagar.id,
            reconciliado_em: new Date().toISOString(),
          })
          .eq("end_to_end_id", endToEndId);

        await supabase.from("fin_sync_log").insert({
          ...logBase,
          tipo: "inter_webhook_pagamento",
          referencia_id: grupoPagar.id,
          status: "pendente_aprovacao",
          resposta: {
            endToEndId,
            valor: valorNum,
            grupo_id: grupoPagar.id,
            mensagem:
              "Pagamento confirmado pelo Inter. Aguardando aprovação para baixa no GC.",
          },
        });
      }

      // Verificar agenda
      const { data: agenda } = await supabase
        .from("fin_agenda_pagamentos")
        .select("id")
        .eq("inter_pagamento_id", endToEndId)
        .maybeSingle();

      if (agenda) {
        await supabase
          .from("fin_agenda_pagamentos")
          .update({
            status: "executado",
            executado_em: dataHora,
          })
          .eq("id", agenda.id);

        await supabase
          .from("fin_extrato_inter")
          .update({
            reconciliado: true,
            agenda_id: agenda.id,
            reconciliado_em: new Date().toISOString(),
          })
          .eq("end_to_end_id", endToEndId);
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from("fin_sync_log")
      .insert({
        ...logBase,
        tipo: "inter_webhook_erro",
        status: "error",
        erro: msg,
      })
      .catch(() => {});

    // Always 200 so Inter doesn't retry
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }
});
