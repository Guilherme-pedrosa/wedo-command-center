# Integridade das negociações

O módulo transforma origens selecionadas em parcelas e saldos residuais, preservando o valor do acordo e as referências de cada título. Uma resposta do ERP, a composição local e a conciliação bancária são evidências diferentes. Quitação no GC não preenche automaticamente `valor_recebido` nem comprova entrada bancária.

Este documento contém contratos e procedimentos técnicos. Os testes usam entidades fictícias; evidências e correções de clientes reais ficam fora do repositório.

## Invariantes

- O valor é calculado em centavos. Parcelas mais resíduos devem conservar o total de cada origem e do acordo.
- Cada recebimento pertence a no máximo um grupo ativo. Itens de grupos cancelados continuam no histórico. Travas por recebimento impedem duas alocações concorrentes.
- Número, cliente, OS, valor original e snapshots de um acordo existente não são reescritos por sincronização. IDs do GC, vínculos e alocações bancárias não desaparecem porque uma consulta por período não encontrou um título.
- Uma composição só é íntegra quando tem todos os itens/OS esperados, somas exatas, cliente compatível e ponteiros válidos. Um ponteiro nulo invalida a composição.
- Grupos pendentes, bloqueados, cancelados ou ainda não verificados não são promovidos automaticamente para pagos. Um subconjunto de itens pagos não comprova quitação integral.
- Datas de pagamento derivam de evidência de liquidação; `now()` não substitui a data financeira.
- Falhas preservam as reservas. Um POST de resultado incerto não é reenviado automaticamente.
- Grupos numerados novos exigem um job capturado em `processando`. O navegador não pode inserir, alterar ou excluir jobs financeiros.
- Alterações de máquina também geram `fin_audit_log`. Exclusões físicas de histórico negociado, pagamentos e vínculos protegidos são recusadas.

`integridade_status='ok'` significa composição conferida. `bloqueio_financeiro=true` mantém operações suspensas enquanto existem motivos documentados. Liberar uma pendência histórica exige revisão com evidências; o contexto de finalização de um job só libera os próprios grupos novos desse job.

## Estados e contratos

### Resíduos

| `fin_residuos_negociacao.estado` | Uso |
|---|---|
| `disponivel` | Pode ser selecionado após confirmar título, cliente, valor e ausência de vínculo ativo. |
| `reservado` | Origem de job em execução, ou novo saldo aguardando verificação final. |
| `alocado` | Já participa de uma negociação; não significa pago. |
| `liquidado` | Título quitado; não pode retornar à seleção por sincronização. |
| `pendente_vinculo` | Falta identificar/vincular o título com segurança. |
| `em_revisao` | Existe divergência que requer conferência. |

`utilizado=true` é mantido para todo estado indisponível, por compatibilidade. Origem, valores e OS históricos são preservados. Os novos resíduos ficam reservados até `fin_finalize_negotiation` confirmar o resultado; somente os novos saldos pertencentes ao job concluído são liberados. Liberar um grupo não é autorização para recriar saldo.

As reservas de origem ficam em `fin_negociacao_reservas`: `reservado`, `consumido` ou `liberado`. A chave `origin_key` identifica `os:<id>` ou `residual:<uuid>` e possui exclusividade enquanto reservada/consumida.

### RPCs

| Função | Contrato | Acesso |
|---|---|---|
| `fin_enqueue_negotiation(jsonb,text,uuid)` | Payload permitido, chave idempotente e ator financeiro; devolve job, estado, número e `reused`. Reserva as origens atomicamente. | `service_role` |
| `fin_claim_negotiation_execution(uuid,uuid)` | Job e token novo; devolve se capturou `pendente → processando`. | `service_role` |
| `fin_persist_negotiation(uuid,jsonb,uuid)` | Job, plano v2 e token atual; valida conservação/identidades e persiste grupos, itens e resíduos em uma transação. | `service_role` |
| `fin_finalize_negotiation(uuid,jsonb,uuid)` | Job, resultado e token atual; só conclui com `success`, `integrity_verified` e zero erros, mais composição verificada no banco. | `service_role` |
| `fin_resume_negotiation(uuid,uuid)` | Job em erro e ator financeiro; preserva número, payload, plano, journal e reservas, removendo o token anterior. Recusa movimentações financeiras posteriores. | `service_role` |
| `fin_solicitar_cancelamento_negociacao(uuid[],text)` | Grupos e motivo; marca revisão/bloqueio e audita. Não conclui cancelamento, apaga registros ou libera resíduos. | Usuário autenticado com permissão financeira |

As versões de persistência/finalização com apenas dois argumentos foram removidas. O token é verificado antes de qualquer gravação ou retorno idempotente: um executor antigo não pode finalizar um job retomado por outro executor.

`negotiate-os` autentica a sessão e verifica `admin`, `ceo` ou `gerente_financeiro`. `enqueue` e `resume` exigem usuário financeiro; `execute` é interno ao worker. `list` e `verify_group` também passam pela autorização. A configuração de JWT da plataforma não substitui `financialActor`.

O plano v2 registra `origins`, `parcelas`, `residuos`, `consumed_residual_ids` e totais em centavos. Cada título contém identidade GC, cliente, valor, vencimento e estado explicitamente aberto. Parcelas precisam de referência da OS. O centro de custo local é mapeado por `fin_centros_custo.codigo`; plano de contas e forma de pagamento usam `gc_id`.

## Falhas e retomadas

| Situação | Tratamento |
|---|---|
| Reenvio da mesma solicitação | Reutilizar a mesma chave e payload; retorna o mesmo job. Payload diferente com a mesma chave é recusado. |
| Worker não acordou | O job continua pendente. Acordar o mesmo job; não criar outra negociação. |
| Execução já em processamento | A captura concorrente falha; não trocar token ou estado pelo navegador. |
| Job em erro, sem movimentação posterior | Usar a ação autenticada `resume`; o journal orienta a conferência das etapas existentes. |
| PUT/POST despachado com resposta incerta | Consultar o efeito existente por GET/identidade e conferir o plano. Ausência de prova mantém pendência; não repetir POST por tentativa cega. |
| Cliente, valor, OS, vencimento ou pagamento divergem | Bloquear, preservar o acordo e conferir os documentos. Não aprovar desconto, mudança de cliente ou novo saldo por inferência. |
| Pedido de cancelamento | Registrar motivo via RPC de solicitação; a resolução financeira permanece pendente. |

`execution_state.steps` registra `dispatching`, `responded` e `verified`, incluindo identidades e resultado observado. `erro` não prova que um efeito externo foi revertido. A atomicidade do PostgreSQL não cria uma transação distribuída com o GC.

## Testes

O workflow **Negotiation integrity**, em `.github/workflows/negotiation-integrity.yml`, roda em pull requests e pushes para `main`, com Node `22.18.0`:

```sh
npm ci --no-audit --no-fund
npm test -- --run
node --experimental-strip-types --test supabase/functions/_shared/negotiation-regression.test.ts
node --experimental-vm-modules scripts/negotiation-regression.mjs supabase/functions/negotiate-os/index.ts src/api/financeiro.ts --finance-only
npm run build
```

Os testes do backend e o harness financeiro são separados. O harness carrega o código real de `src/api/financeiro.ts` com GC/banco simulados e cobre preservação do histórico, falhas de paginação/GET e rejeição de quitação incompleta. Seu relatório JSON é criado em `os.tmpdir()`, nunca no repositório.

O mesmo workflow verifica os sete entrypoints Edge com Deno `2.9.6`, sem gerar lockfile:

```sh
npx --yes deno@2.9.6 check --no-lock supabase/functions/negotiate-os/index.ts supabase/functions/negotiate-os-worker/index.ts supabase/functions/scan-passivos/index.ts supabase/functions/tag-passivos/index.ts supabase/functions/sync-all/index.ts supabase/functions/argus-baixa-confirmada/index.ts supabase/functions/gc-proxy/index.ts
```

### SQL com rollback obrigatório

Os scripts em `supabase/tests/` são testes PL/pgSQL com exceção final deliberada, não testes pgTAP. Execute em banco local ou descartável com todas as migrations aplicadas e conexão administrativa. O teste RPC precisa de um usuário financeiro já existente no ambiente de teste; não cria nem altera usuários.

Configure a conexão local por um serviço libpq, por exemplo `wedo_negotiation_test`. Em PowerShell:

```powershell
$env:PGSERVICE = 'wedo_negotiation_test'
$guardOutput = & psql -X -v ON_ERROR_STOP=1 -f supabase/tests/negotiation-integrity-hardening.sql 2>&1
if ($LASTEXITCODE -eq 0 -or ($guardOutput -join "`n") -notmatch 'INTEGRITY_TESTS_PASSED: 25 checks;') {
    throw 'Teste de integridade não atingiu o sentinel esperado.'
}
$rpcOutput = & psql -X -v ON_ERROR_STOP=1 -f supabase/tests/negotiation-execution-rpc.sql 2>&1
if ($LASTEXITCODE -eq 0 -or ($rpcOutput -join "`n") -notmatch 'NEGOTIATION_RPC_TESTS_PASSED: 28 checks;') {
    throw 'Teste RPC não atingiu o sentinel esperado.'
}
```

O erro esperado é o comprovante de sucesso e causa o rollback de todas as fixtures e auditorias. Qualquer outro erro é falha de teste. Nunca remova ou troque a exceção final por `COMMIT`. O teste RPC redireciona temporariamente `next_negociacao_number()` para uma sequência temporária; o rollback restaura a função original e não consome números reais. Esses SQLs não são executados pelo workflow Node atual.

## Implantação manual

Use o checkout revisado, Supabase CLI autenticada e o projeto explicitamente selecionado. O procedimento não depende de mensagens ao chat do Lovable. Mantenha a abertura de novas negociações suspensa durante a troca de banco/Edge/frontend.

As migrations deste conjunto são, em ordem: `20260909180611`, `20260909180634`, `20260909190000` e `20260909190500`. As duas primeiras fornecem a base de permissões/campos; as demais implementam integridade e execução. Confira o histórico remoto antes de aplicar. `db push --dry-run` lista migrations pendentes sem executá-las. [Referência oficial do CLI](https://supabase.com/docs/reference/cli/supabase-db-push).

```powershell
supabase login
supabase link --project-ref $env:SUPABASE_PROJECT_REF
supabase migration list --linked
supabase db push --dry-run
supabase db push
```

Se o DDL já foi aplicado diretamente, compare funções, permissões e constraints com os arquivos antes de ajustar o histórico. `migration repair --status applied` altera o registro de migrations; não aplica o DDL. Não marque versões como aplicadas apenas para silenciar divergências. [Referência de reparo do histórico](https://supabase.com/docs/reference/cli/supabase-migration-repair).

Publique `negotiate-os` antes do worker, para que o executor antigo não atravesse o novo contrato sem token. Publique o frontend pelo processo normal do projeto após as funções. O deploy por nome e `--project-ref` é suportado pelo CLI. [Referência de deploy de funções](https://supabase.com/docs/reference/cli/supabase-functions-deploy).

```powershell
supabase functions deploy negotiate-os --project-ref $env:SUPABASE_PROJECT_REF
supabase functions deploy gc-proxy --project-ref $env:SUPABASE_PROJECT_REF
supabase functions deploy scan-passivos --project-ref $env:SUPABASE_PROJECT_REF
supabase functions deploy tag-passivos --project-ref $env:SUPABASE_PROJECT_REF
supabase functions deploy sync-all --project-ref $env:SUPABASE_PROJECT_REF
supabase functions deploy argus-baixa-confirmada --project-ref $env:SUPABASE_PROJECT_REF
supabase functions deploy negotiate-os-worker --project-ref $env:SUPABASE_PROJECT_REF
```

Os secrets utilizados são os do ambiente de implantação: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GC_ACCESS_TOKEN` e `GC_SECRET_TOKEN`, além da configuração existente do usuário técnico GC. Não coloque valores desses secrets no código, documentação ou logs.

Após o deploy, execute o smoke de autorização, que não chama execução, scanner ou baixa:

```powershell
node supabase/functions/_shared/negotiation-auth-smoke.mjs $env:SUPABASE_URL
```

Opcionalmente, `SUPABASE_PUBLIC_KEY` habilita a verificação REST anônima. O script descarta os corpos e espera bloqueio HTTP. Confirme também as versões efetivamente publicadas das sete funções e a ausência de permissão de escrita/execução financeira para `anon`/`authenticated`, preservando as RPCs explicitamente concedidas.

Uma implantação incompleta pode bloquear o handler antigo; esse bloqueio é intencional. Não remova guards para recuperar compatibilidade. Em reversão de frontend/Edge, preserve as proteções do banco e as reservas; retome a operação apenas com versão compatível. Reparos históricos usam lotes próprios com pré-condições e snapshots, sem reaplicar valores reais como migration genérica.
