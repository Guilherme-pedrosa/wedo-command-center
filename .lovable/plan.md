
## Objetivo

Trocar o modelo "processa todos os XMLs do índice e tenta casar com pedidos" por "escolho um período, o sistema varre os pedidos de compra desse período e, para cada um, procura a NF/XML correspondente e atualiza tributos + custo". Mais rápido, mais previsível e vinculado a algo tangível pro usuário (a data do pedido).

## Fluxo novo

```text
[UI] Modal "Sincronizar por pedidos"
  ├─ Data início / Data fim (default: mês atual)
  ├─ [ ] Só pedidos sem NF vinculada
  ├─ [ ] Atualizar custo GC quando NF > cadastro
  └─ Botão "Sincronizar N pedidos"
        │
        ▼
[Edge] sync-nfe-por-pedido
  1. Carrega gc_compras no período (data_pedido entre X e Y)
  2. Para cada compra:
       a. Busca XML em fin_nfe_xml_index por CNPJ+numero_nf (nível 1)
          fallback: CNPJ+valor com tolerância (nível 2)
       b. Se achou → parseia XML, casa itens do pedido com itens da NF
          (cProd → codigo_interno, depois nome+preço, depois 1x1)
       c. Upsert em fin_produto_tributos por gc_produto_id
          (respeita excecao_manual, usa vProd-vDesc / qtd)
       d. Se flag "atualizar custo" marcada e diff > 1% → enfileira
          job em fin_gc_write_jobs pro process-gc-write-jobs
  3. Retorna resumo: {compras_processadas, com_nf, sem_nf, itens_atualizados, custos_enfileirados}
```

## Mudanças

### Backend

- **Nova edge function `sync-nfe-por-pedido`** — extraída de `sync-nfe-entrada`, reaproveita `parseXmlItems`, `enrichCompraWithXml` e o picker de itens já existentes. Não faz DELETE, só upsert.
- **Parâmetros:** `{ data_inicio, data_fim, apenas_sem_nf?, atualizar_custo?, compra_codigos? }`.
- **Paginação interna:** processa em lotes de 50 compras, retorna `202` com `next_offset` se estourar 25s (padrão dos syncs existentes).
- **Logging:** grava em `fin_sync_log` com `tipo='sync_nfe_por_pedido'`, incluindo compras sem match pra o usuário ver depois.

### Frontend

- **Novo botão na tela de Compras** (`/financeiro/pagamentos` → aba compras, ou onde faz mais sentido): "Sincronizar NFs por período".
- **Modal** com date-pickers, checkboxes e preview do count de pedidos no período.
- **Progresso** via toast + refetch da tabela ao final.

### O que fica igual

- `sync-nfe-entrada` original permanece pra rodadas em massa e cron; só recebe a correção já aplicada (upsert sem DELETE atacado).
- `fin_produto_tributos_historico` continua auditando toda mudança.
- Botão manual "Atualizar custo GC" na tela de Precificação continua funcionando normalmente.

## Detalhes técnicos

- **Ordem de match compra ↔ XML:**
  1. `cnpj_fornecedor` + `numero_nfe` (exato)
  2. `cnpj_fornecedor` + valor_total dentro de ±1% ou R$5
  3. `chave_nfe` se o pedido tiver esse campo preenchido
- **Ordem de match item pedido ↔ item NF:** cProd normalizado → nome+preço (token score ≥0.45 + diff unit ≤15%) → único-1x1.
- **Custo por unidade:** `(vProd - vDesc) / qCom` (correção já feita).
- **Update de custo no GC:** só se `atualizar_custo=true` E diff > 1% E não for exceção manual. Enfileira job com `payload_hash` pra evitar duplicatas.
- **Timeout:** checkpoint a cada 25s → `202 { next_offset }`, cliente reenvia até `status='completo'`.

## Fora do escopo

- Não mexe no cron atual do sync-all.
- Não altera a UI da Precificação.
- Não muda regra de match — só troca o disparador de "XML → procura pedido" para "pedido → procura XML".
