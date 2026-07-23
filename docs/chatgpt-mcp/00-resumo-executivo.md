# WeDo Operações — resumo executivo

## Resultado

O MCP financeiro existente foi ampliado para um aplicativo operacional de GestãoClick e Auvo. O catálogo gerado contém 26 ferramentas específicas e autenticadas.

O agente não recebe uma ferramenta HTTP genérica e não recebe acesso ao `gc-proxy`. Toda rota externa é fixa no código e possui schema Zod.

## Evidências reutilizadas

- O MCP/OAuth já existente está em `src/lib/mcp/index.ts`.
- A criação real de orçamento usada pelo ecossistema WeDo foi localizada em `proposal-palooza-07/supabase/functions/gc-criar-orcamento/index.ts`.
- A criação real de tarefa preventiva foi localizada em `auvo-gc-sync/supabase/functions/auvo-task-update/index.ts`.
- A criação real de OS foi localizada em `wedo-pick-pack/supabase/functions/generate-os/index.ts`, incluindo `POST /api/ordens_servicos`.
- O MCP final é gerado em `supabase/functions/mcp/index.ts`.

## Capacidades implementadas

### GestãoClick

- buscar e detalhar clientes;
- buscar e detalhar OS;
- buscar e detalhar orçamentos;
- buscar produtos e serviços;
- consultar estoque ao vivo;
- listar situações de orçamento, situações de OS e lojas;
- preparar e confirmar criação de orçamento;
- preparar e confirmar criação de OS.

### Auvo

- buscar clientes operacionais;
- buscar e detalhar equipamentos;
- consultar tarefa;
- listar técnicos;
- listar tipos de tarefa;
- preparar e confirmar criação de tarefa.

### Financeiro

- resumo financeiro;
- recebimentos em aberto;
- pagamentos em aberto.

## Proteções

- autenticação OAuth via Supabase;
- autorização pelos papéis já existentes em `user_roles`;
- preparação e confirmação vinculadas ao usuário, token opaco, expiração e hash canônico do payload;
- reserva atômica de uma ação pendente antes da chamada externa;
- idempotência conservadora;
- auditoria sanitizada;
- CPF/CNPJ, tokens e segredos removidos da auditoria;
- timeout nas APIs;
- fila central de chamadas para respeitar o limite do GestãoClick;
- nenhum retry automático em criações;
- nenhuma exclusão, baixa financeira, emissão fiscal ou proxy arbitrário.

## Estado de entrega

O código foi implementado na branch `feature/wedo-chatgpt-mcp`.

Não foi feito deploy, migration em produção, escrita real no GestãoClick/Auvo ou publicação do aplicativo no workspace do ChatGPT. Essas operações permanecem deliberadamente pendentes para uma janela autorizada.
