---
name: Nunca cancelar órfãos sem confirmação 404
description: sync-all só cancela lançamento ausente da janela após GET individual retornar 404; registros cancelados voltam a ser upsertados se o GC os retornar
type: constraint
---
Em `supabase/functions/sync-all/index.ts`:
- Ausência de um `gc_id` na lista paginada NÃO autoriza cancelamento. `filtrarOrfaosConfirmados`/`orphanRemovidoNoGC` faz `GET /api/{pagamentos|recebimentos}/{gc_id}` (3 tentativas); só 404 explícito confirma remoção. 200, 5xx, rede ou 429 → preserva.
- Proibido excluir gc_ids com `status='cancelado'` dos upserts de `fin_pagamentos`/`fin_recebimentos`. Esse filtro tornava permanente qualquer cancelamento indevido (salários/folha desapareciam dos Resultados Operacionais). Se o GC retorna o lançamento, ele é revivido com o status real do GC.
**Why:** uma reconciliação com lista parcial cancelou 985 lançamentos legítimos e eles nunca voltavam ao sincronizar.
