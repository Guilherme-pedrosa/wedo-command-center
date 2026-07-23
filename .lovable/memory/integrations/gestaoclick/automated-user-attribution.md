---
name: Automated User Attribution GC
description: Operações GC automáticas (argus-baixa-confirmada, tag-passivos) enviam usuario_id=1320473 (usuário API), não o humano logado
type: feature
---
GC atribui operações via API ao dono do token quando `usuario_id` não é informado. Isso poluía o log de auditoria com o nome do humano logado e estourava rate limit percebido.

- `argus-baixa-confirmada` (PUT em `/api/pagamentos/{id}` e `/api/recebimentos/{id}`): injeta `usuario_id: "1320473"` no payload.
- `tag-passivos` (PUT em `/api/recebimentos/{id}` para tag de negociação): injeta `usuario_id: "1320473"`.
- `negotiate-os` NÃO usa 1320473 — mantém `actingGcUserId` do `gc_codigo` do usuário autenticado (memory: User Attribution), pois é ação iniciada por humano.
