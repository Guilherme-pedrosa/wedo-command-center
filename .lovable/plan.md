## Objetivo

Hoje o `os_index.data_saida` reflete a última mudança de status no GC. Resultado: OS executada em 29/04 que mudou de status em 12/05 aparece como "executada em maio". Vamos passar a usar a **data real do checkout do técnico no Auvo** como data de execução, e contabilizar no mês apenas as OS cujo **status atual no GC começa com `EXECUTADO`** e cuja **data de execução cai dentro do mês**.

## Regra de negócio (definitiva)

Uma OS conta no mês X se, e somente se:
1. Status atual no GC começa com `EXECUTADO` (qualquer variante: AGUARDANDO PAGAMENTO, AGUARDANDO NEGOCIAÇÃO, NOTA EMITIDA, FECHADO CHAMADO, GARANTIA, PATRIMÔNIO); **e**
2. `data_execucao_real` (vinda do Auvo) está dentro do mês X.

OS sem `data_execucao_real` (sem task Auvo vinculada ou sem checkout) caem em "Sem data de execução" e não entram em nenhum mês.

## Mudanças

### 1. Schema (`os_index`)
- `data_execucao_real date` — data do checkout do técnico no Auvo
- `data_execucao_origem text` — `auvo_check_out` | `auvo_conclusao` | `auvo_data_tarefa` | `sem_data`
- `auvo_task_id text` — id da task Auvo (atributo GC 73343 "Tarefa OS")
- `data_execucao_sincronizada_em timestamptz`
- Índice em `data_execucao_real`

### 2. Edge function `sync-os-data-execucao`
- Lê OS do `os_index` com `nome_situacao LIKE 'EXECUTADO%'` e janela configurável (default últimos 120 dias)
- Para cada OS: GET no GC para extrair atributo 73343 → pega `auvo_task_id`
- GET no Auvo `/tasks/{id}` → aplica prioridade `checkOutDate > dateConclusion > taskDate`
- Atualiza `data_execucao_real`, `data_execucao_origem`, `auvo_task_id`
- Rate-limit, chunking, e usa sentinel para evitar reprocessar OS já sincronizada no mesmo dia
- Modo `?os_codigo=9326` para teste pontual

### 3. Cron
- pg_cron diário 04:00 BRT chamando `sync-os-data-execucao` com janela 90 dias

### 4. Hook `useMetasResultados` e `useControleGlobal`
- Substituir filtro por `data_saida` por filtro por `data_execucao_real`
- Manter `status LIKE 'EXECUTADO%'`
- Card mostra contagem extra "OS executadas sem data Auvo" (transparência)

### 5. UI — Página Metas
- Card de "Execução de Serviços" passa a usar a nova regra
- Tooltip explica: "Considera OS com status EXECUTADO no GC e data real de execução (checkout do técnico no Auvo) dentro do mês"
- Subtítulo mostra `X OS sem checkout Auvo (não contabilizadas)`

## Teste de validação

Antes de trocar a régua no dashboard:
1. Rodar `sync-os-data-execucao` com `?os_codigo=9326` → esperado `data_execucao_real = 2026-04-29`
2. Rodar backfill nos últimos 120 dias
3. Query comparativa: maio/2026 com nova regra deve cair de R$ 220k para um valor mais baixo (esperado, ~120-150k)
4. Comparar com o "Relatório de Vendas do GC" do usuário → diferença residual deve ser só status `FECHADO CHAMADO`/`PATRIMÔNIO` (que o relatório do GC não lista mas a nossa régua lista)

## Detalhes técnicos

- Secrets já disponíveis: `GC_ACCESS_TOKEN`, `GC_SECRET_TOKEN`, `AUVO_API_KEY`, `AUVO_USER_TOKEN`
- Atributo GC para Tarefa OS: `73343` (regra herdada do projeto Auvo GC Sync)
- Função helper portada: `dataDeRawAuvo(raw)` com prioridade checkOut → conclusão → taskDate
- Timezone: todas as datas tratadas como BRT (-03:00) explícito antes de truncar para `date`
- Idempotente: upsert por `os_id`
