
-- 1) fin_alertas: eventos detectados automaticamente
CREATE TABLE public.fin_alertas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL, -- ap_vencida, ar_atrasada, duplicidade, inconsistencia, etc.
  severidade text NOT NULL DEFAULT 'media', -- critica, alta, media, baixa, info
  titulo text NOT NULL,
  descricao text,
  entidade_tipo text, -- recebimento, pagamento, grupo, os, compra, etc.
  entidade_id text,
  valor_impacto numeric DEFAULT 0,
  evidencias jsonb,
  status text NOT NULL DEFAULT 'aberto', -- aberto, em_analise, resolvido, ignorado
  resolvido_em timestamptz,
  resolvido_por text,
  tarefa_id uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.fin_alertas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_alertas" ON public.fin_alertas FOR SELECT TO anon USING (true);
CREATE POLICY "auth_all_alertas" ON public.fin_alertas FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 2) fin_tarefas: cards do kanban
CREATE TABLE public.fin_tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo text NOT NULL,
  descricao text,
  tipo text NOT NULL DEFAULT 'geral', -- ap, ar, conciliacao, compras, orcamentos, compliance, coleta_dado
  coluna text NOT NULL DEFAULT 'a_fazer', -- a_fazer, em_analise, aguardando_aprovacao, executando, concluido, bloqueado
  posicao integer DEFAULT 0,
  severidade text DEFAULT 'media',
  valor_impacto numeric DEFAULT 0,
  entidade_tipo text,
  entidade_id text,
  centro_custo_id uuid,
  os_codigo text,
  evidencias jsonb,
  plano_acao jsonb,
  alerta_id uuid REFERENCES public.fin_alertas(id),
  atribuido_a text,
  created_by text DEFAULT 'argus',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.fin_tarefas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_tarefas" ON public.fin_tarefas FOR SELECT TO anon USING (true);
CREATE POLICY "auth_all_tarefas" ON public.fin_tarefas FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 3) fin_aprovacoes: sistema de alçadas
CREATE TABLE public.fin_aprovacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tarefa_id uuid REFERENCES public.fin_tarefas(id),
  tipo_acao text NOT NULL, -- baixa, conciliacao, pagamento, correcao
  payload_proposto jsonb,
  estado_anterior jsonb,
  valor numeric DEFAULT 0,
  status text NOT NULL DEFAULT 'pendente', -- pendente, aprovado, recusado
  solicitado_por text,
  aprovado_por text,
  justificativa text,
  created_at timestamptz DEFAULT now(),
  decidido_em timestamptz
);
ALTER TABLE public.fin_aprovacoes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_aprovacoes" ON public.fin_aprovacoes FOR SELECT TO anon USING (true);
CREATE POLICY "auth_all_aprovacoes" ON public.fin_aprovacoes FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 4) fin_audit_log: trilha de auditoria completa
CREATE TABLE public.fin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acao text NOT NULL, -- criar_alerta, mover_tarefa, aprovar, executar, conciliar, etc.
  ator text NOT NULL DEFAULT 'argus', -- argus, usuario@email, etc.
  entidade_tipo text,
  entidade_id text,
  antes jsonb,
  depois jsonb,
  justificativa text,
  evidencias jsonb,
  tarefa_id uuid,
  aprovacao_id uuid,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.fin_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_audit" ON public.fin_audit_log FOR SELECT TO anon USING (true);
CREATE POLICY "auth_all_audit" ON public.fin_audit_log FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 5) fin_model_signals: sinais para previsões
CREATE TABLE public.fin_model_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL, -- atraso_cliente, sazonalidade, concentracao_ap, etc.
  entidade_tipo text,
  entidade_id text,
  periodo text, -- YYYY-MM ou YYYY-WXX
  valor numeric,
  confianca numeric DEFAULT 0.5,
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.fin_model_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_signals" ON public.fin_model_signals FOR SELECT TO anon USING (true);
CREATE POLICY "auth_all_signals" ON public.fin_model_signals FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 6) fin_agent_runs: execuções do agente
CREATE TABLE public.fin_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL, -- radar_daily, reconcile, forecast, execute_action
  status text NOT NULL DEFAULT 'running', -- running, success, error, partial
  inicio timestamptz DEFAULT now(),
  fim timestamptz,
  duracao_ms integer,
  alertas_criados integer DEFAULT 0,
  tarefas_criadas integer DEFAULT 0,
  acoes_executadas integer DEFAULT 0,
  erros jsonb,
  resumo text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.fin_agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_runs" ON public.fin_agent_runs FOR SELECT TO anon USING (true);
CREATE POLICY "auth_all_runs" ON public.fin_agent_runs FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Add FK from alertas to tarefas
ALTER TABLE public.fin_alertas ADD CONSTRAINT fin_alertas_tarefa_id_fkey FOREIGN KEY (tarefa_id) REFERENCES public.fin_tarefas(id);
