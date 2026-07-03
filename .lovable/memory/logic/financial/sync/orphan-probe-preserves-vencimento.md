---
name: Orphan Probe Preserves Vencimento
description: Sync GC probes orphan candidates per-id before deleting to preserve records whose data_vencimento shifted out of the fetched window
type: feature
---
Em `syncRecebimentosGC` e `syncPagamentosGC` (src/api/financeiro.ts), quando um `gc_id` local não aparece na lista GC retornada pela janela `data_inicio/data_fim`, o registro NÃO é apagado direto. `probeOrphansFromGC` faz `GET /api/{recebimentos|pagamentos}/{gc_id}`; se GC responde 200, o registro é reupsertado (atualizando `data_vencimento`, `data_competencia`, `data_liquidacao`, `valor`, `gc_payload_raw`, `status`, `liquidado`); só é deletado quando GC responde 404. Isso garante que vencimentos alterados no GC (movidos para outro mês) sejam propagados sem perder o registro local.
