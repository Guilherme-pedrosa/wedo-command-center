// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { analisarFretes } from './fretes';

const admin = '00000000-0000-0000-0000-000000000001';
const venda = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const descricaoReal = 'Compra de nº 4673 - REEMSOLSO ANGELICA - OS 6449 ENTREGA LIXEIRAS MARIANA';
let db: PGlite;
const fontes = async () => (await db.query<{ tipo: string; registro: Record<string, any> }>('SELECT * FROM fin_comissoes_fontes_frete()')).rows;
const compra = async (frete = 0) => {
  await db.exec('RESET ROLE');
  await db.query('INSERT INTO gc_compras(gc_id,codigo,valor_frete,gc_payload_raw) VALUES ($1,$2,$3,$4)',
    ['777', '4673', frete, { Compra: { id: '777', codigo: '4673', nome_fornecedor: 'LSA TRANSPORTES LTDA', valor_frete: String(frete) } }]);
  await db.exec('SET ROLE authenticated');
};
const ratear = (numeroVenda: number, fonteId: string, valor = 230, limite = 230, justificativa = 'Entrega desta venda conferida') => db.query(
  'INSERT INTO fin_comissoes_conferencias(venda_id,ajustes) VALUES ($1,$2)',
  [venda(numeroVenda), { fretes: [{ fonteId, valor, limite, incluidoNoCusto: false, justificativa }] }]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES ('${admin}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated,anon;
    CREATE FUNCTION public.has_role(uuid,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1 = '${admin}'::uuid AND $2 = 'admin' $$;
    CREATE TABLE gc_vendas(id uuid PRIMARY KEY,gc_id text,codigo text,cliente_id text,nome_cliente text,data date,valor_produtos numeric,valor_total numeric,gc_payload_raw jsonb);
    CREATE TABLE gc_recebimentos(gc_id text,tipo text,cliente_id text,gc_payload_raw jsonb,descricao text,data_vencimento date);
    CREATE TABLE gc_compras(gc_id text,codigo text,valor_frete numeric,gc_payload_raw jsonb);
    CREATE TABLE gc_pagamentos(gc_id text, codigo text, descricao text, nome_fornecedor text, valor_total numeric, liquidado boolean, gc_payload_raw jsonb);
    INSERT INTO gc_vendas SELECT ('10000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,n::text,n::text,'cliente','Cliente de teste','2026-09-14',1000,1050,'{}' FROM generate_series(1,5) n;
    GRANT SELECT,REFERENCES ON gc_vendas TO authenticated;
    GRANT SELECT ON gc_compras,gc_pagamentos,gc_recebimentos TO authenticated;
  `);
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [admin]);
  await db.exec(readFileSync('supabase/migrations/20260914160000_comissoes_vendedores.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20260914230000_comissoes_frete_transportadora.sql', 'utf8'));
  const registros = [
    { gc_id: '593814263', codigo: '41621', descricao: descricaoReal, nome_fornecedor: 'LSA TRANSPORTES LTDA', valor_total: 230, liquidado: true },
    { gc_id: '2', codigo: '2', descricao: 'Compra de nº 4673 - Reembolso de almoço e entrega pessoal', nome_fornecedor: 'Maria Silva', valor_total: 50, liquidado: true },
    { gc_id: '3', codigo: '3', descricao: 'Compra de nº 9000 - Mensalidade', nome_fornecedor: 'LSA TRANSPORTES LTDA', valor_total: 80, liquidado: true },
    { gc_id: '4', codigo: '4', descricao: 'Entrega de mercadoria', nome_fornecedor: 'TELETRANSPORTESERVICE LTDA', valor_total: 75, liquidado: true },
  ];
  for (const p of registros) await db.query('INSERT INTO gc_pagamentos VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [p.gc_id, p.codigo, p.descricao, p.nome_fornecedor, p.valor_total, p.liquidado, { ...p, valor_total: p.valor_total.toFixed(2) }]);
}, 30000);

beforeEach(async () => {
  await db.exec('RESET ROLE; DELETE FROM fin_comissoes_conferencias; DELETE FROM fin_comissoes_auditoria; DELETE FROM gc_compras; SET ROLE authenticated;');
});
afterAll(async () => { await db.close(); });

describe('fontes de frete por finalidade e transportadora', () => {
  it('traz o título real 41621 como fonte avulsa de 230 baixados quando a compra 4673 não está sincronizada', async () => {
    const rows = await fontes();
    const pagamentos = rows.filter(r => r.tipo === 'pagamento').map(r => r.registro);
    expect(pagamentos).toHaveLength(1);
    expect(pagamentos[0]).toMatchObject({ gc_id: '593814263', codigo: '41621', liquidado: true });
    const analisadas = analisarFretes([], pagamentos);
    expect(analisadas).toHaveLength(1);
    expect(analisadas[0]).toMatchObject({ id: 'pagamento:593814263', compraCodigo: '4673', valor: 230, pago: 230 });
    await expect(ratear(1, 'pagamento:593814263')).resolves.toBeDefined();
  });

  it.each([
    [{ descricao: 'REEMSOLSO ANGELICA', nome_fornecedor: 'LSA TRANSPORTES LTDA' }, true],
    [{ descricao: 'Entrega para cliente', nome_fornecedor: 'Entregas Logística Ltda' }, true],
    [{ descricao: 'Coleta', nome_fornecedor: 'Transportadora Ana' }, true],
    [{ descricao: 'Reembolso de viagem', nome_fornecedor: 'Maria Silva' }, false],
    [{ descricao: 'Mensalidade', nome_fornecedor: 'LSA TRANSPORTES LTDA' }, false],
    [{ descricao: 'Entrega', nome_fornecedor: 'TELETRANSPORTESERVICE LTDA' }, false],
    [{ descricao: 'Entrega', nome_fornecedor: 'Lojas Logistical' }, false],
    [{ descricao: 'Coletanea de eventos', nome_fornecedor: 'LSA TRANSPORTES LTDA' }, false],
    [{ descricao: 'Frete de compra', nome_fornecedor: 'Fornecedor' }, true],
    [{ gc_payload_raw: { descricao: 'Reembolso de coleta', nome_fornecedor: 'ABC Logística' } }, true],
    [{ descricao: 'Entrega', nome_fornecedor: '' }, false],
    [{}, false],
  ])('classifica %j sem ampliar somente pelo fornecedor', async (pagamento, esperado) => {
    const resultado = await db.query<{ indica: boolean }>('SELECT fin_comissoes_pagamento_indica_frete($1) AS indica', [pagamento]);
    expect(resultado.rows[0].indica).toBe(esperado);
  });

  it('com compra presente gera uma única fonte e aceita rateio do título como limite sem frete no cabeçalho', async () => {
    await compra();
    const rows = await fontes();
    expect(rows.filter(r => r.tipo === 'compra')).toHaveLength(1);
    const fontesCalculadas = analisarFretes(rows.filter(r => r.tipo === 'compra').map(r => r.registro), rows.filter(r => r.tipo === 'pagamento').map(r => r.registro));
    expect(fontesCalculadas).toHaveLength(1);
    expect(fontesCalculadas[0]).toMatchObject({ id: 'compra:777', valor: 230, pago: 230 });
    await expect(ratear(1, 'compra:777', 130)).resolves.toBeDefined();
    await expect(ratear(2, 'compra:777', 100)).resolves.toBeDefined();
    await expect(ratear(3, 'pagamento:593814263', 1)).rejects.toThrow(/Pedido localizado/);
    await expect(ratear(3, 'compra:777', 1)).rejects.toThrow(/já rateado em outras vendas/);
    expect((await db.query('SELECT count(*)::int AS total FROM fin_comissoes_conferencias')).rows[0]).toEqual({ total: 2 });
  });

  it('rejeita limite forjado e mantém validações de origem, justificativa e saldo', async () => {
    await compra();
    await expect(ratear(1, 'compra:777', 230, 250)).rejects.toThrow(/Valor da fonte mudou/);
    await expect(ratear(1, 'compra:777', 231)).rejects.toThrow(/valor válido/);
    await expect(ratear(1, 'compra:777', 50, 230, '  ')).rejects.toThrow(/justificativa/);
    await expect(ratear(1, 'compra:999', 50)).rejects.toThrow(/Fonte de frete não localizada/);
    expect((await db.query('SELECT count(*)::int AS total FROM fin_comissoes_conferencias')).rows[0]).toEqual({ total: 0 });
  });

  it('mantém o limite explícito do pedido, sem adicionar novamente o pagamento', async () => {
    await compra(300);
    await expect(ratear(1, 'compra:777', 230, 230)).rejects.toThrow(/Valor da fonte mudou/);
    await expect(ratear(1, 'compra:777', 300, 300)).resolves.toBeDefined();
    await expect(ratear(2, 'compra:777', 1, 300)).rejects.toThrow(/já rateado em outras vendas/);
  });

  it('não libera as consultas de fontes para usuários anônimos', async () => {
    await db.exec('RESET ROLE; SET ROLE anon;');
    await expect(fontes()).rejects.toThrow(/permission denied/);
    await expect(db.query("SELECT fin_comissoes_pagamento_indica_frete('{}'::jsonb)")).rejects.toThrow(/permission denied/);
  });
});
