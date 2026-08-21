# Plano de Implementação: NCM e Origem na Precificação

Este plano detalha a inclusão do NCM e da Origem dos produtos na tela de precificação, permitindo a visualização, filtragem e atualização no GestãoClick, além de alertar sobre divergências entre o cadastro e a NF de entrada.

## Ações no Banco de Dados (Backend)

1. **Enriquecimento do Cache**: A função `sync-gc-produtos` já traz o NCM. Vou garantir que a `gc_produtos_cache` também armazene a **Origem** do produto (`origem`), extraída do `raw_gc`.
2. **Extração da Origem na NF**: Ajustar a função `sync-nfe-entrada` para capturar a tag `<orig>` de cada item do XML e persistir na tabela `fin_produto_tributos`.
3. **Permissões**: Garantir que o frontend possa ler e enviar essas informações via `fin_gc_write_jobs`.

## Alterações no Frontend (UI)

1. **Tabela de Precificação**:
  - Adicionar colunas "NCM" e "Origem" (Cadastro vs NF).
  - Destacar NCMs vazios como "Pendente".
  - Exibir alerta visual se a Origem no GC for diferente da Origem na última NF.
2. **Filtros**:
  - Adicionar filtro "Sem NCM" para identificar produtos que precisam de saneamento fiscal.
3. **Ações de Atualização**:
  - Permitir edição individual do NCM e Origem diretamente na linha.
  - Botão "Atualizar NCM/Origem no GC" (similar ao de custo) que envia um job para o `process-gc-write-jobs`.
  - Opção de atualização em lote para os itens selecionados.

## Detalhes Técnicos

- **Origem**: O GestãoClick usa códigos de 0 a 8 para origem da mercadoria. Mapear esses códigos para descrições legíveis (ex: 0 - Nacional, 1 - Estrangeira Importação Direta).
- **Comparação**: A divergência de origem é crítica para o cálculo de impostos (ICMS diferencidado para itens importados).
- **Auditoria**: Toda alteração via UI gerará um job na `fin_gc_write_jobs` para garantir que o ERP reflita a verdade fiscal definida na precificação.

---

### ⚡ Enviado por UEDA

- As atualizações no GC exigem autenticação via service role (já tratada pela Edge Function `gc-proxy` e `process-gc-write-jobs`).
- O frontend enviará apenas os IDs e os novos valores fiscais.