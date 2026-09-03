---
name: Auvo 404 nunca apaga despesas
description: Falha de fetch no Auvo (404/5xx/rede) não pode ser tratada como "sem despesas"; deleteStale só roda com lista confirmada
type: constraint
---
`sync-all` (módulo Auvo) e `sync-auvo-expenses`:
- `fetchExpensesByType` devolve `{items, ok, status}`. Quando `ok=false`, o tipo é registrado em `fetch_failures`, o status do sync vira `partial` e **nenhum** `deleteStaleRows` é executado — os dados do mês em `auvo_expenses_sync` são preservados.
- `deleteStale` também é bloqueado se algum upsert do lote falhar.
- A API Auvo v2 responde **404 quando o filtro não tem nenhuma despesa** no período (ex.: type 50758, 48799 sem lançamentos). Isso é logado como info, não como erro, e continua sem apagar nada.
**Why:** o fluxo antigo chamava `deleteStaleAuvoRows(..., [])` após um 404, emitindo DELETE sem filtro de ids e zerando as despesas Auvo do mês inteiro.
