# FASE B — Migrations 1.1 → 1.9 (núcleo do Bloco 1 da Precificação)

Criar/ajustar as tabelas do motor de Precificação com RLS baseada em `has_role()` usando os perfis recém-criados (`ceo`, `gerente_comercial`, `gerente_financeiro`, `admin`, `vendedor`).

## Escopo (uma única migration consolidada)

### 1.1 — `fin_politica_markup_tabela` + history
- 12 políticas de markup (A, B, P, V, COMERCIAL, SAPORE, RATIONAL A/B/GUERRA, EQUIP A/B/P) com `tipo_id`, `margem_minima`, `modo_sugestao`, `exige_aprovacao_ceo`
- Tabela espelho `_history` + trigger `fn_politica_markup_history` (INSERT/UPDATE)
- **Seed inicial:** 12 linhas pré-populadas

### 1.2 — `fin_eventos_sistema`
- Log de eventos (severidades: info, baixa, media, alta, critica)
- Origem, payload JSONB, entidade vinculada

### 1.3 — `fin_acoes_pendentes`
- Fila de ações com `status` (pendente, em_andamento, concluida, cancelada)
- `destinatario_role` (filtra por role do usuário corrente)

### 1.4 — `fin_gc_price_history` + `fin_gc_custo_history`
- Histórico append-only de mudanças de preço e custo por `gc_produto_id`
- Source: nf | erp | manual | aprovacao_ceo

### 1.5 — `fin_gc_price_aprovacoes`
- Fluxo CEO para alterações abaixo da margem mínima
- `modo_calculo` (completo | rapido), `status` (pendente | aprovada | rejeitada)

### 1.6 — `fin_gc_write_jobs`
- Fila assíncrona de PUT para GC (idempotente por hash)
- Status: pendente, em_andamento, sucesso, erro, descartado

### 1.7 — `fin_gc_price_review_log` + chaves em `fin_configuracoes`
- Log de revisões agendadas
- Seed de 16 chaves (tolerâncias, intervalos, page_size, sentinels de retomada)

### 1.8 — `fin_arredondamento_comercial`
- Regras de arredondamento por faixa de preço (ex: arredondar para `,90` ou `,99`)

### 1.9 — `fin_produto_tributos_historico` (auditoria do existente)
- Snapshots de mudanças em `fin_produto_tributos`
- Trigger AFTER UPDATE para registrar before/after

## RLS — matriz `has_role()`

| Tabela | SELECT | INSERT/UPDATE |
|---|---|---|
| `fin_politica_markup_tabela` | admin, ceo, gerente_comercial, gerente_financeiro | admin, ceo |
| `fin_politica_markup_tabela_history` | admin, ceo, gerente_comercial, gerente_financeiro | service_role |
| `fin_gc_price_history` | admin, ceo, gerente_comercial, gerente_financeiro | admin, ceo, gerente_comercial |
| `fin_gc_custo_history` | admin, ceo, gerente_financeiro | service_role |
| `fin_gc_price_aprovacoes` | authenticated | admin, ceo (UPDATE status) |
| `fin_gc_write_jobs` | authenticated | service_role |
| `fin_eventos_sistema` | authenticated | service_role |
| `fin_acoes_pendentes` | filtrado por `destinatario_role IN roles_do_user` | admin, ceo |
| `fin_arredondamento_comercial` | authenticated | admin, ceo |
| `fin_gc_price_review_log` | authenticated | service_role |
| `fin_produto_tributos_historico` | admin, ceo, gerente_financeiro | service_role (via trigger) |

`anon` = ZERO acesso nessas tabelas. Função helper `has_role()` já existe no projeto.

## Itens deixados para FASE seguinte (não estão nesta migration)

- 1.10 RLS já contemplada inline (não há migration separada)
- 1.11 `gc_vendas_itens` → será criada no Bloco 2 (parser)
- 1.12 `fin_produto_marca` → será criada quando UI de Marca for construída
- 1.13 `gc_produtos_cache` + GENERATED column → vai junto da edge `sync-gc-produtos` no próximo passo
- 1.14 triggers `updated_at` aplicados onde fizer sentido (incluído nesta migration)

## Após executar

Devolvo:
- Lista das tabelas criadas com contagem de policies
- Confirmação do seed das 12 políticas (`SELECT count(*) FROM fin_politica_markup_tabela`)
- Smoke test RLS: query como `anon` deve retornar 0 linhas/erro
- Lista de warnings do linter introduzidos (esperado: 0 novos; pré-existentes 107 ficam para outra rodada)

Aguardo confirmação para avançar para a edge `sync-gc-produtos` (item 1.13 + cron F1/F2/F3).