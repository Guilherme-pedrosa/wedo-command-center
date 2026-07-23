# Publicação controlada no ChatGPT

## Pré-condições

- workspace ChatGPT compatível com aplicativos MCP privados;
- administrador do workspace disponível;
- migration `20260723090000_wedo_mcp_secure_actions.sql` revisada;
- secrets do `.env.example` configurados no runtime Supabase;
- usuários e papéis corretos em `profiles` e `user_roles`;
- ambiente de homologação para as primeiras três gravações.

Documentação oficial vigente do ChatGPT: <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>

## Verificação antes do deploy

```bash
npm test
npx tsc -p tsconfig.app.json --noEmit
npm run build
npx lovable-mcp-extract-manifest
```

O build deve gerar `supabase/functions/mcp/index.ts` sem caminho local do Windows. O manifest deve listar 26 ferramentas e autenticação `oauth`.

## Migration

Não aplicar migrations automaticamente em produção a partir de uma estação desconhecida.

Em uma janela autorizada:

1. comparar o histórico remoto com `supabase/migrations`;
2. revisar o SQL da migration MCP;
3. aplicar primeiro em homologação;
4. validar RLS e expiração de ações;
5. aplicar em produção somente após aprovação.

## Edge Function

O endpoint alvo já existente é:

```text
https://mgiebypxhnmpktljrzjq.supabase.co/functions/v1/mcp
```

Depois da homologação, a publicação controlada da função usa o projeto `mgiebypxhnmpktljrzjq`. O MCP valida OAuth internamente, portanto a função deve ser publicada sem a validação JWT antecipada do gateway:

```bash
supabase functions deploy mcp \
  --project-ref mgiebypxhnmpktljrzjq \
  --no-verify-jwt
```

Não executar esse comando sem autorização explícita para deploy.

## Cadastrar como aplicativo privado

1. No ChatGPT web, abrir as configurações do workspace.
2. Ativar Developer Mode conforme a política do workspace.
3. Abrir Apps e criar um aplicativo privado.
4. Informar o endpoint MCP acima.
5. Permitir a leitura do metadata OAuth e a varredura das ferramentas.
6. Concluir o login Supabase com um usuário da WeDo.
7. Verificar que o catálogo se chama `WeDo Operações — GestãoClick e Auvo`.
8. Conferir que `gc_proxy`, `http_request` e ferramentas de exclusão não aparecem.
9. Publicar inicialmente apenas para um grupo piloto.

## Teste de homologação

Ordem recomendada:

1. `buscar_cliente`;
2. `buscar_produto_servico`;
3. `consultar_estoque`;
4. `buscar_cliente_auvo`;
5. `buscar_equipamentos`;
6. `listar_tecnicos_auvo`;
7. preparar uma tarefa;
8. confirmar uma tarefa de homologação;
9. preparar e confirmar um orçamento de homologação;
10. preparar e confirmar uma OS de homologação;
11. consultar cada registro criado e confirmar ausência de duplicidade.

## Rollback e revogação

- Remover ou desabilitar o aplicativo privado no workspace impede novas chamadas pelo ChatGPT.
- Revogar a sessão OAuth do usuário corta o acesso individual.
- Remover o papel do usuário em `user_roles` corta as ferramentas protegidas.
- Fazer rollback da função MCP para a versão anterior restaura o catálogo financeiro antigo.
- Não excluir as tabelas de auditoria durante rollback.
