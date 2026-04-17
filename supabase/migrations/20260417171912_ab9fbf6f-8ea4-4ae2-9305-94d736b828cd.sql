-- Habilita pg_net (caso ainda não esteja)
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Trigger: ao inserir vínculo em fin_extrato_lancamentos, dispara argus-baixa-confirmada
-- se a data do extrato for >= 2026-04-01 e o lançamento ainda não foi baixado no GC.
CREATE OR REPLACE FUNCTION public.fn_trigger_argus_baixa_confirmada()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_data_extrato date;
  v_tabela text;
  v_already_baixado boolean;
BEGIN
  -- Normaliza nome da tabela (suporta com ou sem prefixo fin_)
  v_tabela := CASE
    WHEN NEW.tabela IN ('fin_pagamentos', 'pagamentos') THEN 'fin_pagamentos'
    WHEN NEW.tabela IN ('fin_recebimentos', 'recebimentos') THEN 'fin_recebimentos'
    ELSE NULL
  END;

  IF v_tabela IS NULL THEN
    RETURN NEW;
  END IF;

  -- Data do extrato vinculado
  SELECT date_trunc('day', data_hora)::date INTO v_data_extrato
  FROM public.fin_extrato_inter
  WHERE id = NEW.extrato_id;

  -- Cutoff: só dispara para vínculos cujo extrato é >= 2026-04-01
  IF v_data_extrato IS NULL OR v_data_extrato < DATE '2026-04-01' THEN
    RETURN NEW;
  END IF;

  -- Verifica se já está baixado no GC
  IF v_tabela = 'fin_pagamentos' THEN
    SELECT COALESCE(gc_baixado, false) INTO v_already_baixado
    FROM public.fin_pagamentos WHERE id = NEW.lancamento_id;
  ELSE
    SELECT COALESCE(gc_baixado, false) INTO v_already_baixado
    FROM public.fin_recebimentos WHERE id = NEW.lancamento_id;
  END IF;

  IF v_already_baixado THEN
    RETURN NEW;
  END IF;

  -- Dispara edge function via pg_net (assíncrono, não bloqueia o INSERT)
  PERFORM extensions.http_post(
    url := 'https://mgiebypxhnmpktljrzjq.supabase.co/functions/v1/argus-baixa-confirmada',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1naWVieXB4aG5tcGt0bGpyempxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5MTA3MzgsImV4cCI6MjA4ODQ4NjczOH0.BXmHfK6frT0KO0uAvky2romxNkJjm4mj-lS8ExGFkrY'
    ),
    body := jsonb_build_object(
      'mode', 'links',
      'links', jsonb_build_array(jsonb_build_object(
        'lancamento_id', NEW.lancamento_id,
        'tabela', v_tabela
      ))
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Nunca bloqueia o INSERT por falha de pg_net
  RAISE WARNING 'fn_trigger_argus_baixa_confirmada falhou: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_argus_baixa_confirmada ON public.fin_extrato_lancamentos;
CREATE TRIGGER trg_argus_baixa_confirmada
AFTER INSERT ON public.fin_extrato_lancamentos
FOR EACH ROW
EXECUTE FUNCTION public.fn_trigger_argus_baixa_confirmada();