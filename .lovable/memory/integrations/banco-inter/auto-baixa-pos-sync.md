---
name: Auto Baixa GC pós-sync Inter
description: Sync-all encadeia reconciliation-engine + argus-baixa-confirmada(auto) para confirmar no GC tudo já recebido no Inter
type: feature
---
Após cada execução do `sync-all` (manual ou pg_cron), dois disparos fire-and-forget acontecem em sequência:

1. **reconciliation-engine** (imediato): casa extratos Inter ↔ fin_pagamentos/recebimentos por nome+data+valor com identidade forte (CNPJ/PIX ou nome ≥80%), valor exato, janelas ±7d (Regra 6) e ±30d (Regras 1-4). Insere vínculos em `fin_extrato_lancamentos`.
2. **Trigger `fn_trigger_argus_baixa_confirmada`**: dispara baixa no GC para cada link novo (cutoff 2026-04-01).
3. **argus-baixa-confirmada modo `auto`** (30s depois): rede de segurança — varre TODOS os vínculos cujo `gc_baixado` é false/null e baixa em lote. Garante consistência se algum pg_net do trigger tiver falhado.

Resultado nos logs do sync-all: `reconciliacao.status = dispatched_async`, `baixa_gc_auto.status = scheduled_30s`.
