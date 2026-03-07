
-- OS reverse index
create table public.os_index (
  id uuid primary key default gen_random_uuid(),
  orc_codigo text not null,
  os_id text not null,
  os_codigo text not null,
  nome_situacao text,
  nome_cliente text,
  agrupado boolean default false,
  todos_orcs text[],
  built_at timestamptz default now()
);
create unique index os_index_orc_codigo_idx on public.os_index(orc_codigo);

-- Index metadata
create table public.os_index_meta (
  id int primary key default 1,
  built_at timestamptz,
  total_os int,
  total_vinculos int,
  total_agrupados int,
  status text default 'idle'
);
insert into public.os_index_meta(id) values(1) on conflict do nothing;

-- Groups (created first for FK)
create table public.grupos_financeiros (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  cliente_id text,
  nome_cliente text,
  valor_total numeric(12,2) not null default 0,
  qtd_itens int default 0,
  status text not null default 'aberto',
  inter_cobranca_id text,
  inter_txid text,
  inter_qrcode text,
  inter_copia_cola text,
  data_vencimento date,
  data_pagamento date,
  valor_recebido numeric(12,2),
  observacao text,
  baixado_gc boolean default false,
  baixado_gc_em timestamptz,
  criado_por text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Receivables
create table public.gc_recebimentos (
  id uuid primary key default gen_random_uuid(),
  gc_id text unique not null,
  gc_codigo text,
  descricao text,
  os_codigo text,
  tipo text,
  valor numeric(12,2) not null,
  juros numeric(12,2) default 0,
  desconto numeric(12,2) default 0,
  valor_total numeric(12,2),
  cliente_id text,
  nome_cliente text,
  fornecedor_id text,
  plano_contas_id text,
  nome_plano_conta text,
  centro_custo_id text,
  nome_centro_custo text,
  conta_bancaria_id text,
  nome_conta_bancaria text,
  forma_pagamento_id text,
  nome_forma_pagamento text,
  data_vencimento date,
  data_liquidacao date,
  data_competencia date,
  liquidado boolean default false,
  grupo_id uuid references public.grupos_financeiros(id) on delete set null,
  last_synced_at timestamptz default now(),
  created_at timestamptz default now()
);

-- Payables
create table public.gc_pagamentos (
  id uuid primary key default gen_random_uuid(),
  gc_id text unique not null,
  gc_codigo text,
  descricao text,
  valor numeric(12,2) not null,
  valor_total numeric(12,2),
  fornecedor_id text,
  nome_fornecedor text,
  cliente_id text,
  plano_contas_id text,
  nome_plano_conta text,
  centro_custo_id text,
  nome_centro_custo text,
  conta_bancaria_id text,
  nome_conta_bancaria text,
  forma_pagamento_id text,
  nome_forma_pagamento text,
  data_vencimento date,
  data_liquidacao date,
  data_competencia date,
  liquidado boolean default false,
  last_synced_at timestamptz default now(),
  created_at timestamptz default now()
);

-- Group items
create table public.grupo_itens (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid references public.grupos_financeiros(id) on delete cascade not null,
  gc_recebimento_id text not null,
  gc_codigo text,
  os_codigo text,
  descricao text,
  nome_cliente text,
  valor numeric(12,2) not null,
  baixado_gc boolean default false,
  baixado_gc_em timestamptz,
  erro_baixa text,
  tentativas int default 0,
  created_at timestamptz default now()
);
create index grupo_itens_grupo_id_idx on public.grupo_itens(grupo_id);

-- Scheduled payables
create table public.pagamentos_programados (
  id uuid primary key default gen_random_uuid(),
  descricao text not null,
  fornecedor_id text,
  nome_fornecedor text,
  chave_pix text,
  tipo_chave_pix text,
  valor numeric(12,2) not null,
  data_vencimento date not null,
  gc_pagamento_id text,
  inter_pagamento_id text,
  status text default 'agendado',
  erro text,
  observacao text,
  baixado_gc boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Sync log
create table public.sync_log (
  id uuid primary key default gen_random_uuid(),
  tipo text not null,
  referencia_id text,
  referencia_tipo text,
  status text,
  payload jsonb,
  resposta jsonb,
  erro text,
  duracao_ms int,
  created_at timestamptz default now()
);
create index sync_log_tipo_idx on public.sync_log(tipo);
create index sync_log_created_at_idx on public.sync_log(created_at desc);

-- Config
create table public.configuracoes (
  chave text primary key,
  valor text,
  updated_at timestamptz default now()
);

insert into public.configuracoes(chave, valor) values
  ('gc_access_token', ''),
  ('gc_secret_token', ''),
  ('inter_client_id', ''),
  ('inter_client_secret', ''),
  ('inter_pix_key', ''),
  ('sync_auto_enabled', 'true'),
  ('sync_interval_min', '5'),
  ('picking_ttl_min', '5'),
  ('confirmacao_modo', 'texto')
on conflict do nothing;

-- Enable RLS on all tables
alter table public.os_index enable row level security;
alter table public.os_index_meta enable row level security;
alter table public.grupos_financeiros enable row level security;
alter table public.gc_recebimentos enable row level security;
alter table public.gc_pagamentos enable row level security;
alter table public.grupo_itens enable row level security;
alter table public.pagamentos_programados enable row level security;
alter table public.sync_log enable row level security;
alter table public.configuracoes enable row level security;

-- Permissive policies (internal app, no public access needed)
-- All authenticated users can access all data
create policy "Authenticated access" on public.os_index for all to authenticated using (true) with check (true);
create policy "Authenticated access" on public.os_index_meta for all to authenticated using (true) with check (true);
create policy "Authenticated access" on public.grupos_financeiros for all to authenticated using (true) with check (true);
create policy "Authenticated access" on public.gc_recebimentos for all to authenticated using (true) with check (true);
create policy "Authenticated access" on public.gc_pagamentos for all to authenticated using (true) with check (true);
create policy "Authenticated access" on public.grupo_itens for all to authenticated using (true) with check (true);
create policy "Authenticated access" on public.pagamentos_programados for all to authenticated using (true) with check (true);
create policy "Authenticated access" on public.sync_log for all to authenticated using (true) with check (true);
create policy "Authenticated access" on public.configuracoes for all to authenticated using (true) with check (true);

-- Also allow anon for now (since app doesn't have auth yet)
create policy "Anon access" on public.os_index for all to anon using (true) with check (true);
create policy "Anon access" on public.os_index_meta for all to anon using (true) with check (true);
create policy "Anon access" on public.grupos_financeiros for all to anon using (true) with check (true);
create policy "Anon access" on public.gc_recebimentos for all to anon using (true) with check (true);
create policy "Anon access" on public.gc_pagamentos for all to anon using (true) with check (true);
create policy "Anon access" on public.grupo_itens for all to anon using (true) with check (true);
create policy "Anon access" on public.pagamentos_programados for all to anon using (true) with check (true);
create policy "Anon access" on public.sync_log for all to anon using (true) with check (true);
create policy "Anon access" on public.configuracoes for all to anon using (true) with check (true);

-- Updated_at trigger function
create or replace function public.update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql set search_path = public;

create trigger update_grupos_financeiros_updated_at before update on public.grupos_financeiros for each row execute function public.update_updated_at_column();
create trigger update_pagamentos_programados_updated_at before update on public.pagamentos_programados for each row execute function public.update_updated_at_column();
