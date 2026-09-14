// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { EventoSituacaoComissao } from './situacao';

const administrador = '00000000-0000-0000-0000-000000000001';
const colaborador = '00000000-0000-0000-0000-000000000002';
const venda = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
let db: PGlite;
const alterar = (ids: string[], retirada: boolean, motivo: string) => db.query<{ resultado: { solicitadas: number; alteradas: number } }>(
  'SELECT fin_comissoes_alterar_situacao($1::uuid[], $2, $3) AS resultado', [ids, retirada, motivo]);
const conferencia = async (n: number) => (await db.query<Record<string, any>>('SELECT * FROM fin_comissoes_conferencias WHERE venda_id=$1', [venda(n)])).rows[0];
const eventos = async (n: number) => (await db.query<EventoSituacaoComissao>('SELECT * FROM fin_comissoes_situacao_eventos WHERE venda_id=$1 ORDER BY created_at,id', [venda(n)])).rows;
const autenticar = (id: string) => db.query('SELECT set_config($1,$2,false)', ['request.jwt.claim.sub', id]);
const pagar = (n: number, valor = 10) => db.query(
  'INSERT INTO fin_comissoes_pagamentos(venda_id,valor,data_pagamento,forma_pagamento,observacao) VALUES ($1,$2,CURRENT_DATE,$3,$4)',
  [venda(n), valor, 'PIX', 'Registro solicitado pela tela de comissão']);
const pagamentos = async (n: number) => (await db.query('SELECT * FROM fin_comissoes_pagamentos WHERE venda_id=$1 ORDER BY created_at,id', [venda(n)])).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${administrador}'),('${colaborador}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated,anon;
    CREATE FUNCTION public.has_role(uuid,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1 = '${administrador}'::uuid AND $2 = 'admin' $$;
    CREATE TABLE profiles(id uuid PRIMARY KEY,nome text);
    INSERT INTO profiles VALUES ('${administrador}','Gestora de comissões');
    CREATE TABLE gc_vendas(id uuid PRIMARY KEY,gc_id text,codigo text,cliente_id text,nome_cliente text,data date,valor_produtos numeric,valor_total numeric,gc_payload_raw jsonb);
    CREATE TABLE gc_recebimentos(gc_id text,tipo text,cliente_id text,gc_payload_raw jsonb,descricao text,data_vencimento date);
    CREATE TABLE gc_compras(gc_id text,codigo text,valor_frete numeric,gc_payload_raw jsonb);
    CREATE TABLE gc_pagamentos(gc_id text,descricao text,gc_payload_raw jsonb);
    INSERT INTO gc_compras VALUES ('10','10',100,'{"Compra":{"valor_frete":"100"}}');
    INSERT INTO gc_vendas SELECT ('10000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,n::text,n::text,'cliente','Cliente de teste','2026-09-14',1000,1050,'{"nome_vendedor":"Vendedor original"}' FROM generate_series(1,12) n;
    GRANT SELECT,REFERENCES ON gc_vendas TO authenticated;
    GRANT SELECT ON gc_compras,gc_pagamentos,gc_recebimentos TO authenticated;
  `);
  await autenticar(administrador);
  await db.exec(readFileSync('supabase/migrations/20260914160000_comissoes_vendedores.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20260914210000_comissoes_situacao.sql', 'utf8'));
  await db.query('INSERT INTO fin_comissoes_conferencias(venda_id,ajustes,conferido,assinatura) VALUES ($1,$2,true,$3)',
    [venda(1), { vendedorNome: 'Vendedora conferida', custoAdicional: 15, fretes: [{ fonteId: 'compra:10', valor: 30, limite: 100, justificativa: 'Rateio anterior', incluidoNoCusto: false }] }, 'assinatura-anterior']);
  await db.query('INSERT INTO fin_comissoes_pagamentos(venda_id,valor,data_pagamento,forma_pagamento,observacao,snapshot) VALUES ($1,50,CURRENT_DATE,$2,$3,$4)',
    [venda(1), 'PIX', 'Pagamento anterior mantido', { comissao: 50 }]);
  await db.exec('SET ROLE authenticated');
}, 30000);

afterAll(async () => { await db.close(); });

it('retira com motivo e autoria auditável, preservando ajustes e pagamentos', async () => {
  const antes = await conferencia(1);
  expect((await alterar([venda(1)], true, '  Venda com atendimento de pós-venda pendente  ')).rows[0].resultado).toEqual({ solicitadas: 1, alteradas: 1 });
  const depois = await conferencia(1);
  expect(depois).toMatchObject({ retirada: true, motivo_retirada: 'Venda com atendimento de pós-venda pendente', conferido: false, assinatura: '', situacao_alterada_por: administrador, ajustes: antes.ajustes });
  expect(depois.situacao_alterada_em).toBeTruthy();
  const historico = await eventos(1);
  expect(historico).toHaveLength(1);
  expect(historico[0]).toMatchObject({ retirada_antes: false, retirada_depois: true, vendedor_nome: 'Vendedora conferida', usuario_id: administrador, usuario_nome: 'Gestora de comissões', motivo: depois.motivo_retirada,
    snapshot: { codigo_venda: '1', cliente_nome: 'Cliente de teste', valor_venda: 1050, total_comissao_pago: 50, conferencia_anterior: { assinatura: 'assinatura-anterior' } } });
  expect((await db.query('SELECT valor,observacao,snapshot FROM fin_comissoes_pagamentos WHERE venda_id=$1', [venda(1)])).rows).toEqual([{ valor: '50.00', observacao: 'Pagamento anterior mantido', snapshot: { comissao: 50 } }]);
  expect((await db.query<{ contexto: string }>("SELECT current_setting('app.fin_comissoes_motivo',true) AS contexto")).rows[0].contexto).toBe('');
});

it('reinclui com novo motivo no histórico e limpa somente o motivo atual', async () => {
  await expect(alterar([venda(1)], false, ' ')).rejects.toThrow(/motivo/);
  const antes = await conferencia(1);
  await alterar([venda(1)], false, 'Pós-venda concluído e comissão liberada');
  expect(await conferencia(1)).toMatchObject({ retirada: false, motivo_retirada: '', ajustes: antes.ajustes, conferido: false, assinatura: '' });
  expect(await eventos(1)).toHaveLength(2);
  expect((await eventos(1))[1]).toMatchObject({ retirada_antes: true, retirada_depois: false, motivo: 'Pós-venda concluído e comissão liberada' });
  expect((await db.query('SELECT count(*)::int AS total FROM fin_comissoes_pagamentos WHERE venda_id=$1', [venda(1)])).rows[0]).toEqual({ total: 1 });
});

it('nega contornar a operação com upsert, metadados forjados ou contexto de sessão', async () => {
  await expect(db.query('UPDATE fin_comissoes_conferencias SET retirada=true,motivo_retirada=$1 WHERE venda_id=$2', ['Motivo forjado', venda(1)])).rejects.toThrow(/operação de retirada/);
  await db.query("SELECT set_config('app.fin_comissoes_motivo','Contexto forjado',false)");
  await expect(db.query('UPDATE fin_comissoes_conferencias SET retirada=true WHERE venda_id=$1', [venda(1)])).rejects.toThrow(/operação de retirada/);
  await expect(db.query('UPDATE fin_comissoes_conferencias SET situacao_alterada_por=$1 WHERE venda_id=$2', [colaborador, venda(1)])).rejects.toThrow(/operação de retirada/);
  await expect(db.query('INSERT INTO fin_comissoes_conferencias(venda_id,retirada,motivo_retirada) VALUES ($1,true,$2)', [venda(3), 'Motivo forjado'])).rejects.toThrow(/operação de retirada/);
  expect(await conferencia(3)).toBeUndefined();
  expect(await eventos(1)).toHaveLength(2);
  await db.query("SELECT set_config('app.fin_comissoes_motivo','',false)");
});

it('RLS permite leitura do histórico e nega escrita direta e usuários não administradores', async () => {
  const historico = await eventos(1);
  await expect(db.query('UPDATE fin_comissoes_situacao_eventos SET motivo=$1 WHERE id=$2', ['Alterado', historico[0].id])).rejects.toThrow(/permission denied/);
  await expect(db.query('DELETE FROM fin_comissoes_situacao_eventos WHERE id=$1', [historico[0].id])).rejects.toThrow(/permission denied/);
  await expect(db.query('INSERT INTO fin_comissoes_situacao_eventos SELECT * FROM fin_comissoes_situacao_eventos LIMIT 1')).rejects.toThrow(/permission denied/);
  await autenticar(colaborador);
  expect(await eventos(1)).toHaveLength(2);
  await expect(alterar([venda(1)], true, 'Sem permissão')).rejects.toThrow(/Somente administradores/);
  await expect(db.query('INSERT INTO fin_comissoes_conferencias(venda_id) VALUES ($1)', [venda(2)])).rejects.toThrow(/row-level security/);
  await autenticar('');
  await expect(alterar([venda(1)], true, 'Sem autenticação')).rejects.toThrow(/Somente administradores/);
  await autenticar(administrador);
  expect(await conferencia(1)).toMatchObject({ retirada: false });
});

it('lote é atômico, limitado e idempotente quando a situação já é a solicitada', async () => {
  await expect(alterar([venda(4), venda(5), venda(99)], true, 'Lote inválido')).rejects.toThrow(/Nenhuma comissão foi alterada/);
  expect(await conferencia(4)).toBeUndefined();
  expect(await eventos(4)).toHaveLength(0);
  await expect(alterar([], true, 'Vazio')).rejects.toThrow(/1 e 200/);
  await expect(alterar(Array.from({ length: 201 }, () => venda(4)), true, 'Muito grande')).rejects.toThrow(/1 e 200/);
  await expect(alterar([venda(4)], true, 'x'.repeat(2001))).rejects.toThrow(/2000/);
  expect((await alterar([venda(4)], false, 'Já ativa')).rows[0].resultado).toEqual({ solicitadas: 1, alteradas: 0 });
  expect(await conferencia(4)).toBeUndefined();
  expect((await alterar([venda(4), venda(5), venda(4)], true, 'Retirada em lote')).rows[0].resultado).toEqual({ solicitadas: 2, alteradas: 2 });
  const anterior = await conferencia(4);
  expect((await alterar([venda(5), venda(4)], true, 'Repetição da solicitação')).rows[0].resultado).toEqual({ solicitadas: 2, alteradas: 0 });
  expect(await conferencia(4)).toEqual(anterior);
  expect(await eventos(4)).toHaveLength(1);
  expect(await eventos(5)).toHaveLength(1);
});

it('upsert comum preserva a retirada atual e não consegue reincluir com payload desatualizado', async () => {
  const antes = await conferencia(4);
  await db.query(`INSERT INTO fin_comissoes_conferencias(venda_id,ajustes,conferido,assinatura) VALUES ($1,$2,false,'')
    ON CONFLICT (venda_id) DO UPDATE SET ajustes=EXCLUDED.ajustes,conferido=EXCLUDED.conferido,assinatura=EXCLUDED.assinatura`,
    [venda(4), { custoAdicional: 25, justificativa: 'Custo atualizado após retirada' }]);
  expect(await conferencia(4)).toMatchObject({ retirada: true, motivo_retirada: antes.motivo_retirada, situacao_alterada_em: antes.situacao_alterada_em, ajustes: { custoAdicional: 25 } });
  await expect(db.query(`INSERT INTO fin_comissoes_conferencias(venda_id,retirada,motivo_retirada) VALUES ($1,false,'')
    ON CONFLICT (venda_id) DO UPDATE SET retirada=EXCLUDED.retirada,motivo_retirada=EXCLUDED.motivo_retirada`, [venda(4)])).rejects.toThrow(/operação de retirada/);
  expect(await eventos(4)).toHaveLength(1);
});

it('retirada preserva rateio histórico mesmo quando a fonte muda; novos ajustes continuam validados', async () => {
  await db.exec('RESET ROLE');
  await db.query("UPDATE gc_compras SET gc_payload_raw='{\"Compra\":{\"valor_frete\":\"200\"}}' WHERE gc_id='10'");
  await db.exec('SET ROLE authenticated');
  const antes = await conferencia(1);
  await alterar([venda(1)], true, 'Reavaliar frete após atualização');
  expect(await conferencia(1)).toMatchObject({ retirada: true, ajustes: antes.ajustes });
  await expect(db.query('UPDATE fin_comissoes_conferencias SET ajustes=$1 WHERE venda_id=$2', [antes.ajustes, venda(1)])).rejects.toThrow(/Valor da fonte/);
});

it('servidor rejeita novo pagamento de comissão retirada mesmo com formulário desatualizado', async () => {
  const estadoQuandoAbriuFormulario = await conferencia(6);
  expect(estadoQuandoAbriuFormulario?.retirada ?? false).toBe(false);
  await alterar([venda(6)], true, 'Retirada por outro administrador após abertura do formulário');
  await expect(pagar(6)).rejects.toThrow(/Comissão retirada/);
  expect(await pagamentos(6)).toHaveLength(0);
  expect((await db.query('SELECT count(*)::int AS total FROM fin_comissoes_auditoria WHERE tabela=$1 AND registro_id=$2', ['fin_comissoes_pagamentos', venda(6)])).rows[0]).toEqual({ total: 0 });
  await alterar([venda(6)], false, 'Revisão concluída: pode registrar pagamento');
  await pagar(6, 25);
  expect(await pagamentos(6)).toHaveLength(1);
});

it('pagamento anterior à retirada permanece no histórico e impede apenas novas inserções', async () => {
  await pagar(7, 40);
  const antes = await pagamentos(7);
  await alterar([venda(7)], true, 'Retirada posterior ao pagamento exige conferência');
  expect((await eventos(7))[0].snapshot.total_comissao_pago).toBe(40);
  await expect(pagar(7, 5)).rejects.toThrow(/Comissão retirada/);
  expect(await pagamentos(7)).toEqual(antes);
  await alterar([venda(7)], false, 'Pagamento anterior conferido, reinclusão autorizada');
  expect(await pagamentos(7)).toEqual(antes);
});

it('retirada já realizada na transação bloqueia pagamento e a falha não deixa auditoria de pagamento', async () => {
  await db.exec('BEGIN');
  try {
    await alterar([venda(8)], true, 'Primeiro retirar, depois tentar registro em formulário antigo');
    await db.exec('SAVEPOINT antes_pagamento');
    await expect(pagar(8)).rejects.toThrow(/Comissão retirada/);
    await db.exec('ROLLBACK TO SAVEPOINT antes_pagamento');
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
  expect(await conferencia(8)).toMatchObject({ retirada: true });
  expect(await eventos(8)).toHaveLength(1);
  expect(await pagamentos(8)).toHaveLength(0);
});

it('proteção de pagamento mantém a restrição a administradores e rejeita venda inexistente', async () => {
  await autenticar(colaborador);
  await expect(pagar(9)).rejects.toThrow(/Somente administradores/);
  await autenticar(administrador);
  await expect(pagar(99)).rejects.toThrow(/Venda não localizada/);
  expect(await pagamentos(9)).toHaveLength(0);
});

it('retirada e pagamento realmente mantêm a mesma trava exclusiva até o fim da transação', async () => {
  const travas = async () => (await db.query(`SELECT classid::text,objid::text,objsubid,mode,granted FROM pg_locks
    WHERE locktype='advisory' AND pid=pg_backend_pid() ORDER BY classid,objid,objsubid`)).rows;
  await db.exec('BEGIN');
  let travaRetirada: Awaited<ReturnType<typeof travas>>;
  try {
    await alterar([venda(10)], true, 'Verificar serialização de operações');
    travaRetirada = await travas();
    expect(travaRetirada).toHaveLength(1);
    expect(travaRetirada[0]).toMatchObject({ mode: 'ExclusiveLock', granted: true });
  } finally {
    await db.exec('ROLLBACK');
  }
  expect(await travas()).toHaveLength(0);
  await db.exec('BEGIN');
  try {
    await pagar(11);
    expect(await travas()).toEqual(travaRetirada!);
  } finally {
    await db.exec('ROLLBACK');
  }
  expect(await travas()).toHaveLength(0);
  expect(await pagamentos(11)).toHaveLength(0);
});
