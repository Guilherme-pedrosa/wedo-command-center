# Catálogo de ferramentas

O catálogo canônico e legível por máquina está em `.lovable/mcp/manifest.json`.

## GestãoClick — leitura

| Ferramenta | Uso |
|---|---|
| `buscar_cliente` | Resolve candidatos por nome, documento, e-mail ou telefone |
| `detalhar_cliente` | Lê o cadastro atual pelo ID |
| `buscar_ordens_servico` | Filtra OS por cliente, código, situação e período |
| `detalhar_ordem_servico` | Lê a OS completa pelo ID |
| `buscar_orcamentos` | Filtra orçamentos |
| `detalhar_orcamento` | Lê o orçamento completo |
| `buscar_produto_servico` | Resolve IDs do catálogo |
| `consultar_estoque` | Consulta saldo e valores atuais |
| `listar_situacoes_orcamento` | Resolve situação válida de orçamento |
| `listar_situacoes_os` | Resolve situação válida de OS |
| `listar_lojas_gc` | Resolve loja válida |

## Auvo — leitura

| Ferramenta | Uso |
|---|---|
| `buscar_cliente_auvo` | Resolve o cliente operacional no Auvo |
| `buscar_equipamentos` | Resolve equipamentos por cliente ou identificação |
| `detalhar_equipamento` | Lê o equipamento completo |
| `consultar_tarefa_auvo` | Lê a tarefa pelo ID |
| `listar_tecnicos_auvo` | Resolve técnico |
| `listar_tipos_tarefa_auvo` | Resolve tipo de tarefa |

## Escritas

Cada escrita exige duas chamadas:

1. `preparar_*` valida a origem, monta o payload final, grava uma ação pendente e devolve a prévia.
2. O modelo mostra a prévia e aguarda confirmação explícita do usuário.
3. `confirmar_*` recebe somente o ID da ação e o token opaco.

Pares disponíveis:

- `preparar_criacao_orcamento` / `confirmar_criacao_orcamento`;
- `preparar_criacao_ordem_servico` / `confirmar_criacao_ordem_servico`;
- `preparar_criacao_tarefa_auvo` / `confirmar_criacao_tarefa_auvo`.

Uma confirmação expira em 10 minutos e só pode ser consumida uma vez pelo mesmo usuário.

## Fora do catálogo

- `gc-proxy`;
- URL ou método HTTP arbitrário;
- exclusões;
- baixa de recebimento ou pagamento;
- emissão fiscal;
- movimentação bancária;
- alteração de estoque ou preço;
- rotinas administrativas em lote.
