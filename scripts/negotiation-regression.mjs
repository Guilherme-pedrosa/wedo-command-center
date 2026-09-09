import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

// Run: node --experimental-vm-modules scripts/negotiation-regression.mjs supabase/functions/negotiate-os/index.ts src/api/financeiro.ts --finance-only
// All entities, references and values are synthetic; no customer data is embedded.
// Loads the actual entrypoint and its local imports. No real credentials, database or fetch are supplied.
const handlerPath = path.resolve(process.argv[2] || '');
const financePath = process.argv[3] ? path.resolve(process.argv[3]) : null;
assert.ok(process.argv[2] && fs.existsSync(handlerPath), 'Pass an explicit existing candidate handler path');
assert.equal(typeof vm.SourceTextModule, 'function', 'Use node --experimental-vm-modules');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const cents = value => Math.round(Number(value) * 100);

function createFixture(options = {}) {
  let id = 0, groupAttempts = 0, nextNumber = 123;
  const gcCalls = [], dbCalls = [], unhandled = [], reservations = new Map();
  const db = {
    fin_grupos_receber: [], fin_grupo_receber_itens: [], fin_recebimentos: [],
    fin_residuos_negociacao: [], fin_sync_log: [], fin_extrato_lancamentos: [],
    fin_negotiation_jobs: [], ...clone(options.seed || {}),
  };
  const fields = { plano_contas_id: 'plan1', forma_pagamento_id: 'form1', conta_bancaria_id: 'bank1', data_competencia: '2026-08-01' };
  const osRecords = new Map([['os1', { id: 'os1', codigo: '9000', tipo: 'servico', cliente_id: options.osClient || 'client1', nome_cliente: 'Mock Client', data: '2026-08-01', valor_total: String(options.osValue ?? 800), situacao_id: '7116099', pagamentos: [{ pagamento: { valor: String(options.osValue ?? 800), ...fields } }] }]]);
  const receipts = new Map((options.receipts || []).map(r => [r.id, { ...fields, liquidado: '0', cliente_id: 'client1', ...clone(r) }]));
  if (options.residual) {
    const r = { id: 'r1', valor_residual: 600, utilizado: false, cliente_gc_id: 'client1', nome_cliente: 'Mock Client', gc_recebimento_id: 'gc-r1', os_codigos: ['9000'], ...clone(options.residual) };
    db.fin_residuos_negociacao.push(r);
    receipts.set(r.gc_recebimento_id, { ...fields, id: r.gc_recebimento_id, codigo: '7001', descricao: 'Passivo OS 9000', valor: String(r.valor_residual), valor_total: String(r.valor_residual), data_vencimento: '2026-09-30', cliente_id: options.residualClient || r.cliente_gc_id, liquidado: options.residualPaid ? '1' : '0' });
  }
  class Query {
    constructor(table) { this.table = table; this.op = 'select'; this.filters = []; this.singleRow = false; }
    select(columns = '*', opts = {}) { this.columns = columns; this.count = opts.count; this.head = opts.head; return this; }
    single() { this.singleRow = true; return this; } maybeSingle() { this.singleRow = true; return this; }
    eq(k, v) { this.filters.push(r => r[k] === v); return this; }
    neq(k, v) { this.filters.push(r => r[k] !== v); return this; }
    in(k, values) { this.filters.push(r => values.includes(r[k])); return this; }
    is(k, v) { this.filters.push(r => v === null ? r[k] == null : r[k] === v); return this; }
    gt(k, v) { this.filters.push(r => r[k] > v); return this; } gte(k, v) { this.filters.push(r => r[k] >= v); return this; }
    lt(k, v) { this.filters.push(r => r[k] < v); return this; } lte(k, v) { this.filters.push(r => r[k] <= v); return this; }
    contains(k, values) { this.filters.push(r => values.every(v => r[k]?.includes(v))); return this; }
    overlaps(k, values) { this.filters.push(r => values.some(v => r[k]?.includes(v))); return this; }
    ilike(k, value) { const re = new RegExp('^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('%', '.*') + '$', 'i'); this.filters.push(r => re.test(r[k] || '')); return this; }
    not(k, op, value) {
      if (op === 'is') this.filters.push(r => value === null ? r[k] != null : r[k] !== value);
      else if (op === 'in') { const values = Array.isArray(value) ? value : String(value).replace(/^\(|\)$/g, '').split(','); this.filters.push(r => !values.includes(r[k])); }
      else throw new Error('UNMOCKED query not operator ' + op);
      return this;
    }
    or(value) {
      const terms = value.split(',').map(x => { const [key, op, ...rest] = x.split('.'); const val = rest.join('.'); return r => op === 'is' ? (val === 'null' ? r[key] == null : String(r[key]) === val) : op === 'eq' ? String(r[key]) === val : (() => { throw new Error('UNMOCKED or: ' + value); })(); });
      this.filters.push(r => terms.some(f => f(r))); return this;
    }
    limit(n) { this.take = n; return this; } range(a, b) { this.offset = a; this.take = b - a + 1; return this; }
    order() { return this; }
    insert(payload) { this.op = 'insert'; this.payload = clone(payload); return this; }
    upsert(payload, opts = {}) { this.op = 'upsert'; this.payload = clone(payload); this.conflict = opts.onConflict || 'id'; return this; }
    update(payload) { this.op = 'update'; this.payload = clone(payload); return this; }
    delete() { this.op = 'delete'; return this; }
    async execute() {
      db[this.table] ??= [];
      let rows = db[this.table].filter(r => this.filters.every(f => f(r)));
      dbCalls.push({ table: this.table, operation: this.op, payload: clone(this.payload), matched: rows.map(r => r.id) });
      if (options.failDb?.(this.table, this.op, clone(this.payload))) return { data: null, error: { message: 'Injected database failure' } };
      if (this.op === 'insert' || this.op === 'upsert') {
        if (this.table === 'fin_grupos_receber' && ++groupAttempts === options.failGroupNumber) return { data: null, error: { message: 'Injected group insertion failure' } };
        rows = [];
        for (const input of Array.isArray(this.payload) ? this.payload : [this.payload]) {
          const conflictKeys = this.conflict?.split(',');
          let r = this.op === 'upsert' ? db[this.table].find(row => conflictKeys.every(k => row[k] === input[k])) : null;
          if (r) Object.assign(r, input); else { r = { id: 'mock-' + ++id, ...input }; db[this.table].push(r); }
          rows.push(r);
        }
      } else if (this.op === 'update') rows.forEach(r => Object.assign(r, this.payload));
      else if (this.op === 'delete') db[this.table] = db[this.table].filter(r => !rows.includes(r));
      const count = rows.length;
      rows = clone(rows.slice(this.offset || 0, this.take == null ? undefined : (this.offset || 0) + this.take));
      for (const row of rows) {
        if (this.columns?.includes('fin_recebimentos')) row.fin_recebimentos = clone(db.fin_recebimentos.find(r => r.id === row.recebimento_id) || null);
        if (this.columns?.includes('fin_grupos_receber')) row.fin_grupos_receber = clone(db.fin_grupos_receber.find(g => g.id === row.grupo_id) || null);
        if (this.columns?.includes('fin_grupo_receber_itens')) row.fin_grupo_receber_itens = clone(db.fin_grupo_receber_itens.filter(i => i.grupo_id === row.id));
        if (this.columns?.includes('fin_extrato_inter')) row.fin_extrato_inter = clone((db.fin_extrato_inter || []).find(e => e.id === row.extrato_id) || null);
      }
      return { data: this.head ? null : this.singleRow ? rows[0] || null : rows, error: null, count };
    }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
  }
  const supabase = {
    from: table => new Query(table),
    auth: { getUser: async () => ({ data: { user: { id: 'test-user' } }, error: null }) },
    functions: { invoke: async (name, request) => {
      if (options.allowVerifyGroup && name === 'negotiate-os' && request.body.action === 'verify_group') return { data: { success: true, integrity_verified: true, grupo_id: request.body.grupo_id }, error: null };
      unhandled.push('Function invocation ' + name); throw new Error('UNMOCKED function ' + name);
    } },
    rpc: async (name, params) => {
      dbCalls.push({ operation: 'rpc', name, params: clone(params) });
      if (name === 'next_negociacao_number') return { data: nextNumber++, error: null };
      if (options.rpcHandlers?.[name]) return options.rpcHandlers[name]({ db, reservations, params, name });
      unhandled.push('RPC ' + name); throw new Error('UNMOCKED RPC ' + name + ': add explicit contract stub; SQL integrity must be validated separately');
    },
  };
  const fetchMock = async (url, options = {}) => {
    const parsed = new URL(typeof url === 'string' ? url : url.url);
    const method = options.method || 'GET'; const pathname = parsed.pathname;
    const payload = options.body ? JSON.parse(options.body) : undefined;
    gcCalls.push({ method, path: pathname, query: parsed.search, payload: clone(payload) });
    if (parsed.origin !== 'https://api.gestaoclick.com') { unhandled.push('Fetch origin ' + parsed.origin); throw new Error('UNMOCKED fetch origin; network disabled'); }
    const injected = optionsForFixture.httpResponse?.({ method, pathname, parsed, payload });
    if (injected) return Response.json(injected.body || { error: 'Injected HTTP failure' }, { status: injected.status || 200 });
    if (method === 'GET' && pathname.startsWith('/api/ordens_servicos/')) {
      const r = osRecords.get(pathname.split('/').at(-1)); return Response.json(r ? { data: clone(r) } : { error: 'Not found' }, { status: r ? 200 : 404 });
    }
    if (method === 'GET' && pathname.startsWith('/api/recebimentos/')) {
      const r = receipts.get(pathname.split('/').at(-1)); return Response.json(r ? { data: clone(r) } : { error: 'Not found' }, { status: r ? 200 : 404 });
    }
    if (method === 'GET' && pathname === '/api/recebimentos') {
      let rows = [...receipts.values()]; const client = parsed.searchParams.get('cliente_id'); if (client) rows = rows.filter(r => r.cliente_id === client);
      const from = parsed.searchParams.get('data_inicio'), to = parsed.searchParams.get('data_fim');
      if (from) rows = rows.filter(r => r.data_vencimento >= from); if (to) rows = rows.filter(r => r.data_vencimento <= to);
      return Response.json({ data: clone(rows), meta: { total_paginas: 1, total_registros: rows.length, pagina_atual: 1 } });
    }
    if (method === 'PUT' && pathname.startsWith('/api/ordens_servicos/')) {
      const osId = pathname.split('/').at(-1); const os = osRecords.get(osId);
      if (!os) return Response.json({ error: 'Not found' }, { status: 404 });
      Object.assign(os, payload);
      if (payload.pagamentos) {
        for (const key of receipts.keys()) if (key.startsWith('gc-' + osId + '-')) receipts.delete(key);
        payload.pagamentos.forEach((wrapper, index) => {
          const p = wrapper.pagamento || wrapper; const gcId = 'gc-' + osId + '-' + index;
          receipts.set(gcId, { ...fields, id: gcId, codigo: String(7100 + index), cliente_id: os.cliente_id, liquidado: '0', descricao: p.descricao || 'Ordem de serviço de nº ' + os.codigo, valor: String(p.valor), valor_total: String(p.valor), data_vencimento: p.data_vencimento, os_id: osId, ordem_servico_id: osId });
        });
      }
      return Response.json({ code: 200, data: clone(os) });
    }
    if (method === 'PUT' && pathname.startsWith('/api/recebimentos/')) {
      if (optionsForFixture.failReceiptPut) return Response.json({ error: 'Injected receipt PUT failure' }, { status: 500 });
      const gcId = pathname.split('/').at(-1), r = receipts.get(gcId);
      if (!r) return Response.json({ error: 'Not found' }, { status: 404 });
      Object.assign(r, payload); if (payload.valor != null) r.valor_total = payload.valor;
      return Response.json({ code: 200, data: clone(r) });
    }
    unhandled.push(method + ' ' + pathname); throw new Error('UNMOCKED GC route; no network attempted: ' + method + ' ' + pathname);
  };
  const optionsForFixture = options;
  const callGC = async request => {
    const url = 'https://api.gestaoclick.com' + request.endpoint + (request.params ? '?' + new URLSearchParams(request.params) : '');
    const response = await fetchMock(url, { method: request.method || 'GET', body: request.payload ? JSON.stringify(request.payload) : undefined });
    return { status: response.status, data: await response.json() };
  };
  return { db, supabase, gcCalls, dbCalls, unhandled, receipts, fetchMock, callGC, reservations };
}

async function loadActualModule(filePath, fixture) {
  let handler;
  const mockEnv = { GC_ACCESS_TOKEN: 'mock-only', GC_SECRET_TOKEN: 'mock-only', SUPABASE_URL: 'https://mock.invalid', SUPABASE_SERVICE_ROLE_KEY: 'mock-only', SUPABASE_ANON_KEY: 'mock-only' };
  const context = vm.createContext({
    Request, Response, URL, URLSearchParams, Headers, TextEncoder, TextDecoder, structuredClone, crypto: globalThis.crypto,
    console: { log() {}, warn() {}, error() {} }, fetch: fixture.fetchMock,
    Deno: { env: { get: key => mockEnv[key] }, serve: fn => { handler = fn; } },
    setTimeout: fn => { queueMicrotask(fn); return 0; }, clearTimeout() {},
  });
  const cache = new Map();
  const synthetic = (key, exports) => {
    if (!cache.has(key)) cache.set(key, new vm.SyntheticModule(Object.keys(exports), function () { for (const [name, value] of Object.entries(exports)) this.setExport(name, value); }, { context, identifier: key }));
    return cache.get(key);
  };
  const noDate = () => { fixture.unhandled.push('date-fns call'); throw new Error('UNMOCKED date-fns helper used'); };
  const resolveModule = async (specifier, referencing) => {
    if (specifier.includes('deno.land/') && specifier.endsWith('/server.ts')) return synthetic('mock:serve', { serve: fn => { handler = fn; } });
    if (specifier.includes('@supabase/supabase-js')) return synthetic('mock:createClient', { createClient: () => fixture.supabase });
    if (specifier.endsWith('/gc-user.ts')) return synthetic('mock:gc-user', { GC_API_USER_ID: 'mock-technical-user', installGcUsuarioId() {} });
    if (specifier === '@/integrations/supabase/client') return synthetic('mock:supabase', { supabase: fixture.supabase });
    if (specifier === '@/lib/gc-client') return synthetic('mock:callGC', { callGC: fixture.callGC, fetchAllGCPages: noDate, checkSyncCooldown: () => ({ allowed: true, remainingSeconds: 0 }), markSyncStarted() {} });
    if (specifier === 'date-fns') return synthetic('mock:dates', { startOfMonth: noDate, endOfMonth: noDate, addMonths: noDate, format: noDate });
    if (specifier === 'date-fns/locale') return synthetic('mock:locale', { ptBR: {} });
    let resolved;
    if (specifier.startsWith('.')) resolved = path.resolve(path.dirname(referencing.identifier), specifier);
    else if (specifier.startsWith('@/')) {
      const parts = filePath.split(path.sep); const srcIndex = parts.lastIndexOf('src');
      if (srcIndex < 0) throw new Error('Cannot resolve alias from non-src module ' + specifier);
      resolved = path.join(...parts.slice(0, srcIndex + 1), specifier.slice(2));
    } else throw new Error('UNMOCKED import ' + specifier);
    if (!fs.existsSync(resolved)) resolved += '.ts';
    return buildModule(resolved);
  };
  const buildModule = async file => {
    if (cache.has(file)) return cache.get(file);
    const source = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip', sourceUrl: file });
    const module = new vm.SourceTextModule(source, { context, identifier: file });
    cache.set(file, module); await module.link(resolveModule); return module;
  };
  const module = await buildModule(filePath); await module.evaluate({ timeout: 10000 });
  return { module, get handler() { return handler; } };
}

const defaultInput = { action: 'execute', os_ids: ['os1'], residual_ids: [], parcelas: 2, valores_parcelas: [400, 400], valor_negociado: 800, mes_inicio: '2026-09', dia_vencimento: 28, cliente_gc_id: 'client1', nome_cliente: 'Mock Client', idempotency_key: 'test-request-1', request_id: 'test-request-1' };
async function execute(input = {}, options = {}) {
  const fixture = createFixture(options); const loaded = await loadActualModule(handlerPath, fixture);
  assert.equal(typeof loaded.handler, 'function', 'Actual entrypoint must register its HTTP handler');
  const invoke = async override => {
    const response = await loaded.handler(new Request('https://mock.invalid/negotiate-os', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mock-auth', 'Idempotency-Key': 'test-request-1' }, body: JSON.stringify({ ...defaultInput, ...input, ...override }) }));
    const body = await response.json();
    assert.deepEqual(fixture.unhandled, [], 'Mock coverage gap must not count as a product rejection');
    return { status: response.status, body };
  };
  return { ...fixture, invoke, first: await invoke() };
}
const writes = result => result.gcCalls.filter(c => c.method !== 'GET');
const tableMutations = result => result.dbCalls.filter(c => ['insert', 'update', 'upsert', 'delete'].includes(c.operation) && !['fin_sync_log', 'fin_negotiation_jobs'].includes(c.table));
function explicitRefusal(result) { return result.first.status >= 400 && result.first.status < 500 && result.first.body.success !== true && Boolean(result.first.body.error || result.first.body.message); }
function safeRefusal(result) { assert.ok(explicitRefusal(result), 'Expected explicit non-500 validation refusal'); assert.equal(writes(result).length, 0, 'Refusal must precede any GC mutation'); assert.equal(tableMutations(result).length, 0, 'Refusal must precede financial table mutation'); }
const results = [];
async function test(name, run) {
  try { const detail = await run(); results.push({ name, status: 'PASS', detail: detail || null }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.message }); }
  process.stdout.write(JSON.stringify(results.at(-1)) + '\n');
}

if (!process.argv.includes('--finance-only')) {
await test('V01 residual-only full 600 => 300+300, or safe refusal', async () => {
  const r = await execute({ os_ids: [], residual_ids: ['r1'], valor_negociado: 600, valores_parcelas: [300, 300] }, { residual: {} });
  if (explicitRefusal(r)) { safeRefusal(r); return 'Feature safely refused before financial mutation'; }
  assert.equal(r.first.body.success, true); assert.deepEqual(r.db.fin_grupos_receber.map(g => cents(g.valor_total)), [30000, 30000]);
  assert.equal([...r.receipts.values()].filter(x => x.liquidado !== '1').reduce((s, x) => s + cents(x.valor), 0), 60000);
});
await test('V02 residual-only partial 600 => 150+150 and remaining300, or safe refusal', async () => {
  const r = await execute({ os_ids: [], residual_ids: ['r1'], valor_negociado: 300, valores_parcelas: [150, 150] }, { residual: {} });
  if (explicitRefusal(r)) { safeRefusal(r); return 'Feature safely refused before financial mutation'; }
  assert.equal(r.first.body.success, true); assert.deepEqual(r.db.fin_grupos_receber.map(g => cents(g.valor_total)), [15000, 15000]);
  const available = r.db.fin_residuos_negociacao.filter(x => !x.utilizado);
  assert.equal(available.reduce((s, x) => s + cents(x.valor_residual), 0), 30000);
  assert.equal([...r.receipts.values()].filter(x => x.liquidado !== '1').reduce((s, x) => s + cents(x.valor), 0), 60000);
});
await test('V03 mixed OS1000 residual500 negotiate600, or safe refusal', async () => {
  const r = await execute({ residual_ids: ['r1'], valor_negociado: 600, valores_parcelas: [300, 300] }, { osValue: 1000, residual: { valor_residual: 500 } });
  if (explicitRefusal(r)) { safeRefusal(r); return 'Feature safely refused before financial mutation'; }
  assert.equal(r.first.body.success, true); assert.deepEqual(r.db.fin_grupos_receber.map(g => cents(g.valor_total)), [30000, 30000]);
  assert.equal(r.db.fin_residuos_negociacao.filter(x => !x.utilizado).reduce((s, x) => s + cents(x.valor_residual), 0), 90000);
});
await test('R01 paid residual cannot be reused', async () => {
  const r = await execute({ os_ids: [], residual_ids: ['r1'], parcelas: 1, valor_negociado: 600, valores_parcelas: [600] }, { residual: {}, residualPaid: true }); safeRefusal(r);
});
await test('C01 OS client mismatch is rejected before writes', async () => {
  const r = await execute({}, { osClient: 'client-other' }); safeRefusal(r);
});
await test('V04 equal-value installment is not classified as passive', async () => {
  const r = await execute({}, { osValue: 1200 });
  assert.equal(r.first.body.success, true);
  const passives = r.db.fin_residuos_negociacao.filter(x => !x.utilizado);
  assert.equal(passives.length, 1); assert.equal(cents(passives[0].valor_residual), 40000);
  assert.equal(passives[0].gc_recebimento_id, 'gc-os1-2');
  assert.equal(r.db.fin_grupo_receber_itens.length, 2);
});
await test('V05 unrelated OS with equal value/date remains untouched', async () => {
  const alien = { id: 'unrelated-rec', descricao: 'Ordem de serviço de nº 9876', valor: '400', valor_total: '400', data_vencimento: '2026-09-28' };
  const r = await execute({ parcelas: 1, valor_negociado: 400, valores_parcelas: [400] }, { osValue: 400, receipts: [alien] });
  assert.equal(r.first.body.success, true);
  assert.equal(writes(r).filter(c => c.path === '/api/recebimentos/unrelated-rec').length, 0);
  assert.ok(!r.db.fin_recebimentos.some(x => x.gc_id === 'unrelated-rec' && x.os_codigo === '9000'));
  assert.equal(r.receipts.get('unrelated-rec').descricao, alien.descricao);
});
await test('A01 failed first group never links its title to second installment', async () => {
  const r = await execute({}, { failGroupNumber: 1 });
  assert.ok(r.dbCalls.some(c => c.table === 'fin_grupos_receber' && c.operation === 'insert'), 'Failure injection must actually be reached');
  assert.notEqual(r.first.body.success, true, 'Incomplete group creation cannot return success');
  for (const item of r.db.fin_grupo_receber_itens) {
    const group = r.db.fin_grupos_receber.find(g => g.id === item.grupo_id);
    assert.ok(group); assert.equal(item.snapshot_data, group.data_vencimento);
  }
});
await test('A03 required receipt PUT failure is visible in result', async () => {
  const r = await execute({ parcelas: 1, valor_negociado: 400, valores_parcelas: [400] }, { osValue: 400, failReceiptPut: true });
  assert.ok(writes(r).some(c => c.path.startsWith('/api/recebimentos/')), 'Failure injection must actually be reached');
  assert.notEqual(r.first.body.success, true, 'Required GC mutation failure cannot return success');
  assert.ok(r.first.status >= 400 || r.first.body.summary?.errors > 0 || r.first.body.error, 'Failure must appear in summary or HTTP response');
});
await test('I01 repeat the actual request, preserving one financial effect', async () => {
  const r = await execute(); assert.equal(r.first.body.success, true);
  const before = { groups: clone(r.db.fin_grupos_receber), links: clone(r.db.fin_grupo_receber_itens), writes: writes(r).length };
  const second = await r.invoke();
  assert.ok(second.body.success === true || [409, 422].includes(second.status));
  assert.deepEqual(r.db.fin_grupos_receber, before.groups); assert.deepEqual(r.db.fin_grupo_receber_itens, before.links); assert.equal(writes(r).length, before.writes);
});
await test('D01 January31 clamps February and preserves March', async () => {
  const r = await execute({ parcelas: 3, valores_parcelas: [100, 100, 100], valor_negociado: 300, mes_inicio: '2026-01', dia_vencimento: 31 }, { osValue: 300 });
  assert.equal(r.first.body.success, true);
  assert.deepEqual(r.db.fin_grupos_receber.map(g => g.data_vencimento), ['2026-01-31', '2026-02-28', '2026-03-31']);
});
}

if (financePath) {
  const settlementSeed = () => ({
    fin_grupos_receber: [{ id: 'settle-group', cliente_gc_id: 'client1', status: 'aberto', valor_total: 600, valor_recebido: null, itens_total: 1, os_codigos: ['9000'], integridade_status: 'ok', bloqueio_financeiro: false }],
    fin_grupo_receber_itens: [{ id: 'settle-item', grupo_id: 'settle-group', recebimento_id: 'settle-rec', valor: 600, gc_baixado: false, snapshot_valor: 600, snapshot_data: '2026-09-30', os_codigo_original: '9000' }],
    fin_recebimentos: [{ id: 'settle-rec', gc_id: 'gc-settle', descricao: 'OS 9000', valor: 600, liquidado: false, status: 'pendente', grupo_id: 'settle-group', os_codigo: '9000' }],
    fin_extrato_lancamentos: [{ id: 'settle-allocation', extrato_id: 'settle-statement', tabela: 'recebimentos', lancamento_id: 'settle-rec', valor_alocado: 600 }],
    fin_extrato_inter: [{ id: 'settle-statement', reconciliado: true, valor: 600 }],
  });
  const settlementReceipt = { id: 'gc-settle', cliente_id: 'client1', descricao: 'OS 9000', valor: '600', valor_total: '600', data_vencimento: '2026-09-30' };
  await test('G03 complete GC-paid group syncs status without duplicate payment or invented bank receipt', async () => {
    const f = createFixture({ seed: settlementSeed(), receipts: [{ ...settlementReceipt, liquidado: '1', data_liquidacao: '2026-09-01' }], allowVerifyGroup: true });
    const { module } = await loadActualModule(financePath, f);
    const result = await module.namespace.baixarGrupoReceberNoGC('settle-group', '2026-09-09');
    assert.deepEqual(f.unhandled, []); assert.equal(result.falha, 0); assert.equal(writes(f).length, 0);
    assert.equal(f.db.fin_recebimentos[0].status, 'pago'); assert.equal(f.db.fin_grupos_receber[0].valor_recebido, null);
    assert.equal(f.dbCalls.filter(c => c.table === 'fin_grupos_receber' && c.operation === 'update').length, 0, 'Group status belongs to SQL trigger, not the browser');
    assert.equal(f.db.fin_grupo_receber_itens[0].gc_baixado_em, '2026-09-01');
    assert.equal(f.db.fin_grupo_receber_itens[0].snapshot_valor, 600); assert.equal(f.db.fin_grupo_receber_itens[0].snapshot_data, '2026-09-30');
    assert.equal(f.db.fin_recebimentos[0].data_liquidacao, '2026-09-01');
  });
  for (const [name, mutate, receipt] of [
    ['G04 live title exceeds allocation', seed => seed, { ...settlementReceipt, valor: '650', valor_total: '650' }],
    ['G04b lower live amount has no documented discount', seed => seed, { ...settlementReceipt, valor: '599.99', valor_total: '599.99' }],
    ['G05 live title belongs to another customer', seed => seed, { ...settlementReceipt, cliente_id: 'other-client' }],
    ['G06 pending title has no confirmed bank allocation', seed => { seed.fin_extrato_inter[0].reconciliado = false; return seed; }, settlementReceipt],
  ]) await test(name + ': settlement rejected before any write', async () => {
    const f = createFixture({ seed: mutate(settlementSeed()), receipts: [receipt] });
    const { module } = await loadActualModule(financePath, f);
    let error; try { await module.namespace.baixarGrupoReceberNoGC('settle-group', '2026-09-09'); } catch (e) { error = e.message; }
    assert.ok(error && !/UNMOCKED|not a function|Cannot read properties/i.test(error));
    assert.deepEqual(f.unhandled, []); assert.equal(writes(f).length, 0); assert.equal(tableMutations(f).length, 0);
    assert.equal(f.db.fin_grupos_receber[0].status, 'aberto');
  });
  await test('G07 confirmed bank allocation permits one GC settlement, verified by subsequent GET', async () => {
    const f = createFixture({ seed: settlementSeed(), receipts: [settlementReceipt], allowVerifyGroup: true });
    const { module } = await loadActualModule(financePath, f);
    const result = await module.namespace.baixarGrupoReceberNoGC('settle-group', '2026-09-09');
    assert.deepEqual(f.unhandled, []); assert.equal(result.falha, 0);
    assert.equal(writes(f).length, 1); assert.equal(writes(f)[0].path, '/api/recebimentos/gc-settle');
    assert.ok(f.gcCalls.filter(c => c.method === 'GET' && c.path === '/api/recebimentos/gc-settle').length >= 2);
    assert.equal(f.db.fin_recebimentos[0].status, 'pago'); assert.equal(f.db.fin_grupos_receber[0].valor_recebido, null);
    assert.equal(f.dbCalls.filter(c => c.table === 'fin_grupos_receber' && c.operation === 'update').length, 0, 'Group status belongs to SQL trigger, not the browser');
  });
  const syncSeed = () => ({
    fin_grupos_receber: [{ id: 'sync-group', status: 'pago', valor_total: 200, itens_total: 1, os_codigos: ['9000'] }],
    fin_grupo_receber_itens: [{ id: 'sync-item', grupo_id: 'sync-group', recebimento_id: 'sync-rec', valor: 200, gc_baixado: true }],
    fin_recebimentos: [{ id: 'sync-rec', gc_id: 'gc-historical', descricao: 'OS 9000', data_vencimento: '2026-09-28', valor: 200, liquidado: true, status: 'pago', grupo_id: 'sync-group' }],
    fin_extrato_lancamentos: [{ id: 'allocation', extrato_id: 'statement', tabela: 'fin_recebimentos', lancamento_id: 'sync-rec', valor: 200 }],
    fin_extrato_inter: [{ id: 'statement', lancamento_id: 'sync-rec', reconciliado: true, reconciliation_rule: 'confirmed-manual', valor: 200 }],
  });
  const otherReceipt = { id: 'gc-another', descricao: 'OS 9123', valor: '100', valor_total: '100', data_vencimento: '2026-09-15' };
  const assertSyncHistory = f => {
    assert.deepEqual(f.unhandled, []);
    assert.equal(writes(f).length, 0, 'Sync inspection must not write the GC');
    assert.equal(f.db.fin_recebimentos.find(r => r.id === 'sync-rec')?.gc_id, 'gc-historical');
    assert.deepEqual(f.db.fin_grupo_receber_itens, syncSeed().fin_grupo_receber_itens);
    assert.deepEqual(f.db.fin_extrato_lancamentos, syncSeed().fin_extrato_lancamentos);
    assert.deepEqual(f.db.fin_extrato_inter, syncSeed().fin_extrato_inter);
    assert.equal(f.db.fin_grupos_receber[0].valor_total, 200);
  };
  await test('S01 actual sync preserves historical links when title moved to another month', async () => {
    const f = createFixture({ seed: syncSeed(), receipts: [otherReceipt, { id: 'gc-historical', descricao: 'OS 9000', valor: '200', valor_total: '200', data_vencimento: '2026-10-28', liquidado: '1' }] });
    const { module } = await loadActualModule(financePath, f);
    await module.namespace.syncRecebimentosGC(undefined, { dataInicio: '2026-09-01', dataFim: '2026-09-30', incluirLiquidados: true });
    assertSyncHistory(f);
    assert.ok(f.gcCalls.some(c => c.path === '/api/recebimentos/gc-historical'), 'Per-ID refresh was exercised');
    assert.equal(f.db.fin_recebimentos.find(r => r.id === 'sync-rec').data_vencimento, '2026-10-28');
  });
  await test('S02 actual sync preserves historical links and allocation on GC404', async () => {
    const f = createFixture({ seed: syncSeed(), receipts: [otherReceipt] });
    const { module } = await loadActualModule(financePath, f);
    await module.namespace.syncRecebimentosGC(undefined, { dataInicio: '2026-09-01', dataFim: '2026-09-30', incluirLiquidados: true });
    assert.ok(f.gcCalls.some(c => c.path === '/api/recebimentos/gc-historical'), 'GC404 path was exercised'); assertSyncHistory(f);
    assert.equal(f.db.fin_grupos_receber[0].bloqueio_financeiro, true);
    assert.equal(f.db.fin_grupos_receber[0].integridade_status, 'pendente');
  });
  await test('S03 actual sync preserves history on per-ID GC500', async () => {
    const f = createFixture({ seed: syncSeed(), receipts: [otherReceipt], httpResponse: c => c.pathname === '/api/recebimentos/gc-historical' ? { status: 500 } : null });
    const { module } = await loadActualModule(financePath, f);
    await module.namespace.syncRecebimentosGC(undefined, { dataInicio: '2026-09-01', dataFim: '2026-09-30', incluirLiquidados: true });
    assert.ok(f.gcCalls.some(c => c.path === '/api/recebimentos/gc-historical'), 'Injected GC500 was exercised'); assertSyncHistory(f);
  });
  await test('S03b actual sync preserves history on incomplete list page', async () => {
    const f = createFixture({ seed: syncSeed(), receipts: [otherReceipt], httpResponse: c => c.pathname === '/api/recebimentos' ? c.parsed.searchParams.get('pagina') === '2' ? { status: 500 } : { status: 200, body: { data: [otherReceipt], meta: { total_paginas: 2 } } } : null });
    const { module } = await loadActualModule(financePath, f);
    let error; try { await module.namespace.syncRecebimentosGC(undefined, { dataInicio: '2026-09-01', dataFim: '2026-09-30', incluirLiquidados: true }); } catch (e) { error = e.message; }
    assert.ok(f.gcCalls.some(c => c.query.includes('pagina=2')), 'Second-page failure was exercised');
    assert.ok(error || f.db.fin_sync_log.some(x => x.status !== 'success'), 'Incomplete list must be reported'); assertSyncHistory(f);
  });
  await test('G01 actual group settlement rejects empty composition', async () => {
    const f = createFixture({ seed: { fin_grupos_receber: [{ id: 'g1', valor_total: 850, status: 'aberto', itens_total: 2, os_codigos: ['8001', '8002'] }] } });
    const { module } = await loadActualModule(financePath, f);
    let error; try { await module.namespace.baixarGrupoReceberNoGC('g1', '2026-09-09'); } catch (e) { error = e.message; }
    assert.ok(!error || !/UNMOCKED|not a function|Cannot read properties/i.test(error), 'Fixture/runtime failure is not a valid composition rejection: ' + error);
    assert.deepEqual(f.unhandled, []); assert.notEqual(f.db.fin_grupos_receber[0].status, 'pago'); assert.equal(writes(f).length, 0);
    assert.ok(error || f.db.fin_sync_log.some(x => x.status !== 'success'), 'Caller receives a failure/incomplete status');
  });
  await test('G02 actual group settlement rejects all-paid incomplete subset', async () => {
    const f = createFixture({ seed: {
      fin_grupos_receber: [{ id: 'g1', valor_total: 2500, status: 'aberto', itens_total: 2, os_codigos: ['8011', '8012'] }],
      fin_grupo_receber_itens: [{ id: 'i1', grupo_id: 'g1', recebimento_id: 'rec1', valor: 1600, gc_baixado: true, os_codigo_original: '8011' }],
      fin_recebimentos: [{ id: 'rec1', gc_id: 'gc-paid', valor: 1600, liquidado: true, status: 'pago', os_codigo: '8011' }],
    } });
    const { module } = await loadActualModule(financePath, f);
    let error; try { await module.namespace.baixarGrupoReceberNoGC('g1', '2026-09-09'); } catch (e) { error = e.message; }
    assert.ok(!error || !/UNMOCKED|not a function|Cannot read properties/i.test(error), 'Fixture/runtime failure is not a valid composition rejection: ' + error);
    assert.deepEqual(f.unhandled, []); assert.notEqual(f.db.fin_grupos_receber[0].status, 'pago'); assert.equal(writes(f).length, 0);
  });
}

const output = { candidate: handlerPath, financeiro: financePath, executedAt: new Date().toISOString(), noNetwork: true, limitation: 'GC and database mocked. Actual imported entrypoint code exercised; SQL/RPC concurrency is not certified by this harness.', results };
const reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'negotiation-regression-'));
const reportPath = path.join(reportDirectory, 'results.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(output, null, 2));
process.stdout.write(JSON.stringify({ passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length, reportPath, noNetwork: true }) + '\n');
process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
