---
name: Auto Status Faturado pós-grupo
description: Ao criar grupo a receber, OS com situação 8889036 (EXECUTADO - FECHADO CHAMADO) viram 9203836 (CHAMADO FECHADO - FATURADO) no GC, sem tocar em financeiros
type: feature
---
Edge function `update-os-faturado` é disparada (fire-and-forget) após criar grupo em `RecebimentosPage.handleCreateGroup` e `SmartGroupDialog.handleCreate`.

Resolve `os_id` via `os_index.os_codigo` ← `fin_grupo_receber_itens.os_codigo_original`.

Para cada OS: GET no GC, só age se `situacao_id === "8889036"`. PUT preserva apenas campos não-financeiros (equipamentos, produtos, servicos, atributos, vendedor, técnico, observações etc.). **OMITE** `pagamentos`, `condicao_pagamento`, `forma_pagamento_id`, `data_primeira_parcela`, `numero_parcelas`, `intervalo_dias` — assim o GC não recria/altera nenhum título financeiro já vinculado ao grupo.

IDs:
- ORIGEM: 8889036 (EXECUTADO - FECHADO CHAMADO)
- DESTINO: 9203836 (CHAMADO FECHADO - FATURADO)
