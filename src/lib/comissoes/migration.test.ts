// @vitest-environment node
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {it} from 'vitest';
it('migração de comissões, vínculos e limites de rateio no PostgreSQL',async()=>{
const db=new PGlite();
await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid primary key); INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000001');
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION public.has_role(uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TABLE gc_vendas(id uuid primary key,gc_id text,codigo text,cliente_id text,data date,valor_produtos numeric);
CREATE TABLE gc_recebimentos(gc_id text,tipo text,cliente_id text,gc_payload_raw jsonb,descricao text,data_vencimento date);
CREATE TABLE gc_compras(gc_id text,codigo text,valor_frete numeric,gc_payload_raw jsonb);
CREATE TABLE gc_pagamentos(gc_id text,descricao text,gc_payload_raw jsonb);
INSERT INTO gc_compras VALUES ('10','10',100,'{"Compra":{"valor_frete":"100"}}');
INSERT INTO gc_vendas VALUES ('00000000-0000-0000-0000-000000000002','392687738','1773530751','40298492','2026-08-20',8990),('00000000-0000-0000-0000-000000000003','2','2','2','2026-09-14',100);
INSERT INTO gc_recebimentos VALUES ('594076497','venda','60440974','{}','Venda de nº 1773530751','2026-11-13'),('595611090','venda','40298463','{}','Venda de nº 1773530751','2026-11-13');`);
await db.exec(readFileSync('supabase/migrations/20260914160000_comissoes_vendedores.sql','utf8'));
const {rows}=await db.query<{recebimentos:unknown[];venda:{codigo_unico:boolean}}>(`SELECT * FROM fin_comissoes_dados('2026-08-01','2026-08-31')`);
assert.equal(rows[0].recebimentos.length,2);assert.equal(rows[0].venda.codigo_unico,true);
await db.query('SELECT * FROM fin_comissoes_fontes_frete()');
const ajuste=JSON.stringify({fretes:[{fonteId:'compra:10',valor:60,limite:100,incluidoNoCusto:false,justificativa:'Rateio conferido'}]});
await db.query('INSERT INTO fin_comissoes_conferencias(venda_id,ajustes) VALUES ($1,$2)', ['00000000-0000-0000-0000-000000000002',ajuste]);
await assert.rejects(()=>db.query('INSERT INTO fin_comissoes_conferencias(venda_id,ajustes) VALUES ($1,$2)', ['00000000-0000-0000-0000-000000000003',ajuste]),/já rateado/);
const resto=JSON.stringify({fretes:[{fonteId:'compra:10',valor:40,limite:100,incluidoNoCusto:true,justificativa:'Frete já no custo'}]});
await db.query('INSERT INTO fin_comissoes_conferencias(venda_id,ajustes) VALUES ($1,$2)', ['00000000-0000-0000-0000-000000000003',resto]);
assert.equal((await db.query('SELECT * FROM fin_comissoes_auditoria')).rows.length,2);
assert.equal((await db.query('SELECT * FROM fin_comissoes_fontes_frete()')).rows.length,3);
await assert.rejects(()=>db.query('UPDATE fin_comissoes_conferencias SET ajustes=$1 WHERE venda_id=$2',[JSON.stringify({fretes:[{fonteId:'compra:10',valor:70,limite:200,justificativa:'Inválido'}]}),'00000000-0000-0000-0000-000000000002']),/Valor da fonte/);

await db.close();

},30000);
