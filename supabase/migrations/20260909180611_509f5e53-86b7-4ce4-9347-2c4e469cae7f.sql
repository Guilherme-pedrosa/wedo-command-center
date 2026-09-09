-- ═══════════════ 1) Integridade / bloqueio nos grupos a receber ═══════════════
ALTER TABLE public.fin_grupos_receber
  ADD COLUMN IF NOT EXISTS integridade_status text NOT NULL DEFAULT 'nao_verificado',
  ADD COLUMN IF NOT EXISTS integridade_motivos jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS bloqueio_financeiro boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bloqueio_motivo text,
  ADD COLUMN IF NOT EXISTS integridade_verificado_em timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fin_grupos_receber_integridade_status_chk'
  ) THEN
    ALTER TABLE public.fin_grupos_receber
      ADD CONSTRAINT fin_grupos_receber_integridade_status_chk
      CHECK (integridade_status IN ('nao_verificado', 'ok', 'pendente'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fin_grupos_receber_integridade
  ON public.fin_grupos_receber (integridade_status)
  WHERE integridade_status <> 'ok';

CREATE INDEX IF NOT EXISTS idx_fin_grupos_receber_bloqueio
  ON public.fin_grupos_receber (bloqueio_financeiro)
  WHERE bloqueio_financeiro;

-- ═══════════════ 2) Estado dos passivos (resíduos) ═══════════════
ALTER TABLE public.fin_residuos_negociacao
  ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'disponivel',
  ADD COLUMN IF NOT EXISTS reservado_job_id text,
  ADD COLUMN IF NOT EXISTS reservado_em timestamptz,
  ADD COLUMN IF NOT EXISTS estado_motivo text,
  ADD COLUMN IF NOT EXISTS valor_alocado numeric NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fin_residuos_estado_chk'
  ) THEN
    ALTER TABLE public.fin_residuos_negociacao
      ADD CONSTRAINT fin_residuos_estado_chk
      CHECK (estado IN ('disponivel', 'reservado', 'alocado', 'liquidado', 'pendente_vinculo', 'em_revisao'));
  END IF;
END $$;

-- Backfill conservador: quem já estava indisponível continua indisponível.
UPDATE public.fin_residuos_negociacao
SET estado = CASE
      WHEN utilizado THEN 'alocado'
      WHEN gc_recebimento_id IS NULL OR btrim(gc_recebimento_id) = '' THEN 'pendente_vinculo'
      ELSE 'disponivel'
    END
WHERE estado = 'disponivel';

CREATE INDEX IF NOT EXISTS idx_fin_residuos_estado
  ON public.fin_residuos_negociacao (estado);

-- Guarda: estado indisponível força utilizado=true e nunca libera automaticamente.
CREATE OR REPLACE FUNCTION public.fn_residuos_estado_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.estado IN ('reservado', 'alocado', 'liquidado') THEN
    NEW.utilizado := true;
  END IF;

  IF TG_OP = 'UPDATE'
     AND COALESCE(OLD.utilizado, false) = true
     AND COALESCE(NEW.utilizado, false) = false
     AND NEW.estado NOT IN ('disponivel', 'pendente_vinculo', 'em_revisao') THEN
    -- Liberação só é permitida junto com a mudança explícita de estado.
    NEW.utilizado := true;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_residuos_estado_guard ON public.fin_residuos_negociacao;
CREATE TRIGGER trg_residuos_estado_guard
  BEFORE INSERT OR UPDATE ON public.fin_residuos_negociacao
  FOR EACH ROW EXECUTE FUNCTION public.fn_residuos_estado_guard();

-- ═══════════════ 3) Proteção contra exclusão física ═══════════════
CREATE OR REPLACE FUNCTION public.fn_guard_delete_grupo_receber()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_baixados int;
BEGIN
  IF COALESCE(OLD.bloqueio_financeiro, false) THEN
    RAISE EXCEPTION 'Grupo % está com bloqueio financeiro; remova o bloqueio (auditável) antes de excluir.', OLD.id;
  END IF;

  IF OLD.status = 'pago' THEN
    RAISE EXCEPTION 'Grupo % está pago; use cancelamento auditável em vez de exclusão física.', OLD.id;
  END IF;

  SELECT count(*) INTO v_baixados
  FROM public.fin_grupo_receber_itens
  WHERE grupo_id = OLD.id AND COALESCE(gc_baixado, false);

  IF v_baixados > 0 THEN
    RAISE EXCEPTION 'Grupo % possui % item(ns) já baixado(s) no ERP; exclusão física bloqueada.', OLD.id, v_baixados;
  END IF;

  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_guard_delete_grupo_receber ON public.fin_grupos_receber;
CREATE TRIGGER trg_guard_delete_grupo_receber
  BEFORE DELETE ON public.fin_grupos_receber
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_delete_grupo_receber();

CREATE OR REPLACE FUNCTION public.fn_guard_delete_recebimento()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_itens int;
  v_links int;
BEGIN
  SELECT count(*) INTO v_itens FROM public.fin_grupo_receber_itens WHERE recebimento_id = OLD.id;
  IF v_itens > 0 THEN
    RAISE EXCEPTION 'Recebimento % está vinculado a % item(ns) de grupo; exclusão física bloqueada (marque pendência).', OLD.id, v_itens;
  END IF;

  SELECT count(*) INTO v_links
  FROM public.fin_extrato_lancamentos
  WHERE lancamento_id = OLD.id;
  IF v_links > 0 THEN
    RAISE EXCEPTION 'Recebimento % possui % alocação(ões) de extrato; exclusão física bloqueada.', OLD.id, v_links;
  END IF;

  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_guard_delete_recebimento ON public.fin_recebimentos;
CREATE TRIGGER trg_guard_delete_recebimento
  BEFORE DELETE ON public.fin_recebimentos
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_delete_recebimento();

-- ═══════════════ 4) Idempotência dos jobs de negociação ═══════════════
ALTER TABLE public.fin_negociacao_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS created_by_user uuid,
  ADD COLUMN IF NOT EXISTS negociacao_numero integer,
  ADD COLUMN IF NOT EXISTS plano jsonb,
  ADD COLUMN IF NOT EXISTS etapas jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_negociacao_jobs_idempotency
  ON public.fin_negociacao_jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ═══════════════ 5) RLS: sem acesso anônimo, escrita só para perfis financeiros ═══════════════
CREATE OR REPLACE FUNCTION public.has_financeiro_write(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND role IN ('admin', 'ceo', 'gerente_financeiro')
  )
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_grupos_receber', 'fin_grupo_receber_itens', 'fin_recebimentos', 'fin_negociacao_jobs']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Anon access" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated access" ON public.%I', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY "fin_select_autenticado" ON public.%I FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL)$f$, t);
    EXECUTE format($f$CREATE POLICY "fin_insert_financeiro" ON public.%I FOR INSERT TO authenticated WITH CHECK (public.has_financeiro_write(auth.uid()))$f$, t);
    EXECUTE format($f$CREATE POLICY "fin_update_financeiro" ON public.%I FOR UPDATE TO authenticated USING (public.has_financeiro_write(auth.uid())) WITH CHECK (public.has_financeiro_write(auth.uid()))$f$, t);
    EXECUTE format($f$CREATE POLICY "fin_delete_financeiro" ON public.%I FOR DELETE TO authenticated USING (public.has_financeiro_write(auth.uid()))$f$, t);
  END LOOP;
END $$;

-- Resíduos: leitura para autenticados, escrita para perfis financeiros.
DROP POLICY IF EXISTS "Authenticated users can manage residuos" ON public.fin_residuos_negociacao;
REVOKE ALL ON public.fin_residuos_negociacao FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fin_residuos_negociacao TO authenticated;
GRANT ALL ON public.fin_residuos_negociacao TO service_role;
CREATE POLICY "residuos_select_autenticado" ON public.fin_residuos_negociacao
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
CREATE POLICY "residuos_insert_financeiro" ON public.fin_residuos_negociacao
  FOR INSERT TO authenticated WITH CHECK (public.has_financeiro_write(auth.uid()));
CREATE POLICY "residuos_update_financeiro" ON public.fin_residuos_negociacao
  FOR UPDATE TO authenticated USING (public.has_financeiro_write(auth.uid())) WITH CHECK (public.has_financeiro_write(auth.uid()));
CREATE POLICY "residuos_delete_financeiro" ON public.fin_residuos_negociacao
  FOR DELETE TO authenticated USING (public.has_financeiro_write(auth.uid()));