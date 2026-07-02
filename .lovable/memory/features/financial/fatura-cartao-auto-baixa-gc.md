---
name: Fatura Cartão Auto Baixa GC
description: Ao vincular extrato à fatura de cartão (conciliação), baixa automática de todos os financeiros GC vinculados como Confirmado com data_compensacao=data_vencimento da fatura
type: feature
---

Trigger: `handleVincularExtrato` em `FaturaCartaoPage.tsx` após inserir vínculos e marcar fatura como paga.

Fluxo:
1. Coleta todas `fin_fatura_transacoes.lancamento_id` da fatura (tabela=fin_pagamentos)
2. Invoca `argus-baixa-confirmada` mode:'links' com `data_liquidacao_override = fatura.data_vencimento`
3. Cada link recebe também `observacao_contexto` com nome do cartão e vencimento

Extensão em `argus-baixa-confirmada`:
- LinkInput agora aceita `data_liquidacao_override` (yyyy-mm-dd) e `observacao_contexto`
- Quando override presente, pula lookup de extrato e usa data direto
- Preserva demais campos (descrição, valor, plano_contas, etc.) — só altera situação/liquidado e data_liquidacao

Regra: nenhum outro campo do financeiro no GC é modificado além de `liquidado=1`, `data_liquidacao` e observação com marca [Argus].
