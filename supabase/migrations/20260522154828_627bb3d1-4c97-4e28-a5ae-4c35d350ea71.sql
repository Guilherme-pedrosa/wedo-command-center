
-- =========================================================
-- FASE B: Migrations 1.1 → 1.9 — Núcleo de Precificação
-- =========================================================

-- Helper: trigger genérico de updated_at já existe (public.update_updated_at_column)

-- ---------------------------------------------------------
-- 1.1  fin_politica_markup_tabela + history + seed
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_politica_markup_tabela (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_id text NOT NULL UNIQUE,
  nome_tabela text NOT NULL,
  margem_minima numeric(6,4) NOT NULL DEFAULT 0.30,
  modo_sugestao text NOT NULL DEFAULT 'sugerir' CHECK (modo_sugestao IN ('sugerir','automatico','manual_only')),
  exige_aprovacao_ceo boolean NOT NULL DEFAULT false,
  ativo boolean NOT NULL DEFAULT true,
  observacao text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fin_politica_markup_tabela_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  politica_id uuid NOT NULL,
  tipo_id text NOT NULL,
  acao text NOT NULL CHECK (acao IN ('INSERT','UPDATE','DELETE')),
  antes jsonb,
  depois jsonb,
  ator uuid,
  created_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.fn_politica_markup_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.fin_politica_markup_tabela_history(politica_id, tipo_id, acao, depois, ator)
    VALUES (NEW.id, NEW.tipo_id, 'INSERT', to_jsonb(NEW), auth.uid());
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.fin_politica_markup_tabela_history(politica_id, tipo_id, acao, antes, depois, ator)
    VALUES (NEW.id, NEW.tipo_id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), auth.uid());
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.fin_politica_markup_tabela_history(politica_id, tipo_id, acao, antes, ator)
    VALUES (OLD.id, OLD.tipo_id, 'DELETE', to_jsonb(OLD), auth.uid());
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_politica_markup_history ON public.fin_politica_markup_tabela;
CREATE TRIGGER trg_politica_markup_history
  AFTER INSERT OR UPDATE OR DELETE ON public.fin_politica_markup_tabela
  FOR EACH ROW EXECUTE FUNCTION public.fn_politica_markup_history();

DROP TRIGGER IF EXISTS trg_politica_markup_updated_at ON public.fin_politica_markup_tabela;
CREATE TRIGGER trg_politica_markup_updated_at
  BEFORE UPDATE ON public.fin_politica_markup_tabela
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed das 12 tabelas
INSERT INTO public.fin_politica_markup_tabela (tipo_id, nome_tabela, margem_minima, modo_sugestao, exige_aprovacao_ceo) VALUES
  ('509609','Tabela A - (Sodexo, GR, CLIENTES A PRAZO)',0.30,'sugerir',false),
  ('509605','Tabela B (Consumidor Final, PAG a vista, BENEFICIOS, REPRESENT)',0.25,'sugerir',true),
  ('509606','Tabela P (Parceiros / Revenda)',0.18,'sugerir',true),
  ('509607','Tabela V (Vendas Internas)',0.20,'sugerir',false),
  ('509608','Tabela COMERCIAL',0.22,'sugerir',false),
  ('509610','Tabela SAPORE',0.20,'sugerir',true),
  ('509611','Tabela RATIONAL A',0.25,'sugerir',false),
  ('509612','Tabela RATIONAL B',0.22,'sugerir',false),
  ('509613','Tabela RATIONAL GUERRA',0.15,'sugerir',true),
  ('509614','Tabela EQUIP A',0.28,'sugerir',false),
  ('509615','Tabela EQUIP B',0.24,'sugerir',false),
  ('509616','Tabela EQUIP P',0.18,'sugerir',true)
ON CONFLICT (tipo_id) DO NOTHING;

-- ---------------------------------------------------------
-- 1.2  fin_eventos_sistema
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_eventos_sistema (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL,
  severidade text NOT NULL DEFAULT 'info' CHECK (severidade IN ('info','baixa','media','alta','critica')),
  origem text NOT NULL,
  titulo text NOT NULL,
  descricao text,
  entidade_tipo text,
  entidade_id text,
  payload jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_eventos_sistema_created ON public.fin_eventos_sistema(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fin_eventos_sistema_sev ON public.fin_eventos_sistema(severidade);

-- ---------------------------------------------------------
-- 1.3  fin_acoes_pendentes
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_acoes_pendentes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL,
  destinatario_role public.app_role NOT NULL DEFAULT 'admin',
  titulo text NOT NULL,
  descricao text,
  payload jsonb,
  entidade_tipo text,
  entidade_id text,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','em_andamento','concluida','cancelada')),
  resolvido_por uuid,
  resolvido_em timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_acoes_pendentes_dest ON public.fin_acoes_pendentes(destinatario_role, status);

DROP TRIGGER IF EXISTS trg_acoes_pendentes_updated_at ON public.fin_acoes_pendentes;
CREATE TRIGGER trg_acoes_pendentes_updated_at
  BEFORE UPDATE ON public.fin_acoes_pendentes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------
-- 1.4  fin_gc_price_history + fin_gc_custo_history
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_gc_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gc_produto_id text NOT NULL,
  tipo_id text NOT NULL,
  preco_anterior numeric(14,4),
  preco_novo numeric(14,4) NOT NULL,
  margem_aplicada numeric(6,4),
  source text NOT NULL CHECK (source IN ('nf','erp','manual','aprovacao_ceo','sync')),
  motivo text,
  aprovacao_id uuid,
  ator uuid,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_gc_price_history_prod ON public.fin_gc_price_history(gc_produto_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.fin_gc_custo_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gc_produto_id text NOT NULL,
  custo_anterior numeric(14,4),
  custo_novo numeric(14,4) NOT NULL,
  source text NOT NULL CHECK (source IN ('nf','erp','manual','sync')),
  nf_chave text,
  motivo text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_gc_custo_history_prod ON public.fin_gc_custo_history(gc_produto_id, created_at DESC);

-- ---------------------------------------------------------
-- 1.5  fin_gc_price_aprovacoes
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_gc_price_aprovacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gc_produto_id text NOT NULL,
  nome_produto text,
  tipo_id text NOT NULL,
  modo_calculo text NOT NULL DEFAULT 'completo' CHECK (modo_calculo IN ('completo','rapido')),
  custo_referencia numeric(14,4),
  preco_atual numeric(14,4),
  preco_solicitado numeric(14,4) NOT NULL,
  margem_resultante numeric(6,4),
  margem_minima_politica numeric(6,4),
  justificativa text,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovada','rejeitada')),
  solicitado_por uuid,
  decidido_por uuid,
  decidido_em timestamptz,
  decisao_observacao text,
  payload jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_gc_price_aprov_status ON public.fin_gc_price_aprovacoes(status, created_at DESC);

DROP TRIGGER IF EXISTS trg_gc_price_aprov_updated_at ON public.fin_gc_price_aprovacoes;
CREATE TRIGGER trg_gc_price_aprov_updated_at
  BEFORE UPDATE ON public.fin_gc_price_aprovacoes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------
-- 1.6  fin_gc_write_jobs
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_gc_write_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recurso text NOT NULL,
  recurso_id text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','em_andamento','sucesso','erro','descartado')),
  tentativas int NOT NULL DEFAULT 0,
  ultimo_erro text,
  resposta jsonb,
  iniciado_em timestamptz,
  finalizado_em timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (recurso, recurso_id, payload_hash)
);
CREATE INDEX IF NOT EXISTS idx_fin_gc_write_jobs_status ON public.fin_gc_write_jobs(status, created_at);

DROP TRIGGER IF EXISTS trg_gc_write_jobs_updated_at ON public.fin_gc_write_jobs;
CREATE TRIGGER trg_gc_write_jobs_updated_at
  BEFORE UPDATE ON public.fin_gc_write_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------
-- 1.7  fin_gc_price_review_log + seed em fin_configuracoes
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_gc_price_review_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  produtos_analisados int DEFAULT 0,
  produtos_alterados int DEFAULT 0,
  paginas_processadas int DEFAULT 0,
  duracao_ms int,
  status text NOT NULL DEFAULT 'sucesso',
  detalhes jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_gc_price_review_log_created ON public.fin_gc_price_review_log(created_at DESC);

-- Seed das 16 chaves de configuração (apenas se chave nao existir)
INSERT INTO public.fin_configuracoes (chave, valor, descricao) VALUES
  ('PRECIF_TOLERANCIA_PRECO_PCT','0.02','Tolerância percentual para considerar preço inalterado'),
  ('PRECIF_TOLERANCIA_PRECO_ABS','0.05','Tolerância absoluta R$ para considerar preço inalterado'),
  ('PRECIF_INTERVALO_SYNC_MIN','60','Intervalo em minutos para sync de produtos GC'),
  ('PRECIF_SYNC_TIMEOUT_S','25','Timeout em segundos antes de checkpoint no sync'),
  ('PRECIF_SYNC_PAGE_SIZE','100','Quantidade de produtos por página GC'),
  ('LAST_SYNC_GC_PRODUTOS_PAGE','0','Última página processada (retomada)'),
  ('LAST_SYNC_GC_PRODUTOS_COMPLETED_AT','','Timestamp ISO do último sync completo'),
  ('LAST_SYNC_GC_PRODUTOS_STARTED_AT','','Timestamp ISO do início do sync corrente'),
  ('PRECIF_MODO_DEFAULT','sugerir','Modo padrão de cálculo (sugerir|automatico|manual_only)'),
  ('PRECIF_MARGEM_MINIMA_FALLBACK','0.20','Margem mínima se política não encontrada'),
  ('PRECIF_REGIME_TRIBUTARIO','lucro_real','Regime tributário ativo'),
  ('PRECIF_ALIQUOTA_IRPJ_CSLL','0.24','Alíquota combinada IRPJ + CSLL'),
  ('PRECIF_HABILITAR_AUTO_APROVACAO','false','Permite aplicar preço sem aprovação se acima da margem mínima'),
  ('PRECIF_ARREDONDAMENTO_ATIVO','true','Aplica regras de fin_arredondamento_comercial'),
  ('PRECIF_DIAS_VALIDADE_NF','365','Validade em dias de tributos via NF antes de re-buscar'),
  ('PRECIF_MAX_RETRIES_GC','3','Máximo de tentativas em fin_gc_write_jobs')
ON CONFLICT (chave) DO NOTHING;

-- ---------------------------------------------------------
-- 1.8  fin_arredondamento_comercial
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_arredondamento_comercial (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  faixa_min numeric(14,4) NOT NULL,
  faixa_max numeric(14,4) NOT NULL,
  terminacao text NOT NULL,
  estrategia text NOT NULL DEFAULT 'mais_proximo' CHECK (estrategia IN ('mais_proximo','para_cima','para_baixo')),
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CHECK (faixa_max > faixa_min)
);

DROP TRIGGER IF EXISTS trg_arredondamento_updated_at ON public.fin_arredondamento_comercial;
CREATE TRIGGER trg_arredondamento_updated_at
  BEFORE UPDATE ON public.fin_arredondamento_comercial
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------
-- 1.9  fin_produto_tributos_historico + trigger
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_produto_tributos_historico (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_tributo_id uuid NOT NULL,
  gc_produto_id text NOT NULL,
  acao text NOT NULL CHECK (acao IN ('INSERT','UPDATE','DELETE')),
  antes jsonb,
  depois jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_prod_trib_hist_prod ON public.fin_produto_tributos_historico(gc_produto_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.fn_produto_tributos_historico()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.fin_produto_tributos_historico(produto_tributo_id, gc_produto_id, acao, depois)
    VALUES (NEW.id, NEW.gc_produto_id, 'INSERT', to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.fin_produto_tributos_historico(produto_tributo_id, gc_produto_id, acao, antes, depois)
    VALUES (NEW.id, NEW.gc_produto_id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.fin_produto_tributos_historico(produto_tributo_id, gc_produto_id, acao, antes)
    VALUES (OLD.id, OLD.gc_produto_id, 'DELETE', to_jsonb(OLD));
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_produto_tributos_historico ON public.fin_produto_tributos;
CREATE TRIGGER trg_produto_tributos_historico
  AFTER INSERT OR UPDATE OR DELETE ON public.fin_produto_tributos
  FOR EACH ROW EXECUTE FUNCTION public.fn_produto_tributos_historico();

-- =========================================================
-- RLS: Habilitar e aplicar policies por has_role()
-- =========================================================

ALTER TABLE public.fin_politica_markup_tabela ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_politica_markup_tabela_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_eventos_sistema ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_acoes_pendentes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_gc_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_gc_custo_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_gc_price_aprovacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_gc_write_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_gc_price_review_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_arredondamento_comercial ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_produto_tributos_historico ENABLE ROW LEVEL SECURITY;

-- ----- fin_politica_markup_tabela -----
CREATE POLICY "precif_politica_select" ON public.fin_politica_markup_tabela
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(),'gerente_comercial')
    OR public.has_role(auth.uid(),'gerente_financeiro')
  );
CREATE POLICY "precif_politica_insert" ON public.fin_politica_markup_tabela
  FOR INSERT TO authenticated WITH CHECK (
    public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
  );
CREATE POLICY "precif_politica_update" ON public.fin_politica_markup_tabela
  FOR UPDATE TO authenticated USING (
    public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
  ) WITH CHECK (
    public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
  );
CREATE POLICY "precif_politica_delete" ON public.fin_politica_markup_tabela
  FOR DELETE TO authenticated USING (
    public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
  );

-- ----- fin_politica_markup_tabela_history -----
CREATE POLICY "precif_politica_hist_select" ON public.fin_politica_markup_tabela_history
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(),'gerente_comercial')
    OR public.has_role(auth.uid(),'gerente_financeiro')
  );

-- ----- fin_eventos_sistema -----
CREATE POLICY "precif_eventos_select" ON public.fin_eventos_sistema
  FOR SELECT TO authenticated USING (true);

-- ----- fin_acoes_pendentes -----
CREATE POLICY "precif_acoes_select" ON public.fin_acoes_pendentes
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(), destinatario_role)
  );
CREATE POLICY "precif_acoes_insert" ON public.fin_acoes_pendentes
  FOR INSERT TO authenticated WITH CHECK (
    public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
  );
CREATE POLICY "precif_acoes_update" ON public.fin_acoes_pendentes
  FOR UPDATE TO authenticated USING (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(), destinatario_role)
  ) WITH CHECK (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(), destinatario_role)
  );

-- ----- fin_gc_price_history -----
CREATE POLICY "precif_price_hist_select" ON public.fin_gc_price_history
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(),'gerente_comercial')
    OR public.has_role(auth.uid(),'gerente_financeiro')
  );
CREATE POLICY "precif_price_hist_insert" ON public.fin_gc_price_history
  FOR INSERT TO authenticated WITH CHECK (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(),'gerente_comercial')
  );

-- ----- fin_gc_custo_history -----
CREATE POLICY "precif_custo_hist_select" ON public.fin_gc_custo_history
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(),'gerente_financeiro')
  );

-- ----- fin_gc_price_aprovacoes -----
CREATE POLICY "precif_aprov_select" ON public.fin_gc_price_aprovacoes
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "precif_aprov_insert" ON public.fin_gc_price_aprovacoes
  FOR INSERT TO authenticated WITH CHECK (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(),'gerente_comercial')
  );
CREATE POLICY "precif_aprov_update" ON public.fin_gc_price_aprovacoes
  FOR UPDATE TO authenticated USING (
    public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
  ) WITH CHECK (
    public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
  );

-- ----- fin_gc_write_jobs -----
CREATE POLICY "precif_jobs_select" ON public.fin_gc_write_jobs
  FOR SELECT TO authenticated USING (true);

-- ----- fin_gc_price_review_log -----
CREATE POLICY "precif_review_log_select" ON public.fin_gc_price_review_log
  FOR SELECT TO authenticated USING (true);

-- ----- fin_arredondamento_comercial -----
CREATE POLICY "precif_arred_select" ON public.fin_arredondamento_comercial
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "precif_arred_insert" ON public.fin_arredondamento_comercial
  FOR INSERT TO authenticated WITH CHECK (
    public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
  );
CREATE POLICY "precif_arred_update" ON public.fin_arredondamento_comercial
  FOR UPDATE TO authenticated USING (
    public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
  ) WITH CHECK (
    public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
  );
CREATE POLICY "precif_arred_delete" ON public.fin_arredondamento_comercial
  FOR DELETE TO authenticated USING (
    public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ceo')
  );

-- ----- fin_produto_tributos_historico -----
CREATE POLICY "precif_trib_hist_select" ON public.fin_produto_tributos_historico
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(),'admin')
    OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(),'gerente_financeiro')
  );
