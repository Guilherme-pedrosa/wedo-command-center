CREATE TABLE IF NOT EXISTS public.tv_tecnicos_premiacao_cache (
  cache_key text PRIMARY KEY,
  ano integer NOT NULL,
  mes integer NOT NULL CHECK (mes BETWEEN 1 AND 12),
  payload jsonb,
  refreshed_at timestamptz,
  refreshing boolean NOT NULL DEFAULT false,
  refresh_started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tv_tecnicos_premiacao_cache ENABLE ROW LEVEL SECURITY;

-- A função Edge usa service_role. Não é necessário expor o cache diretamente
-- para anon/authenticated: a tela continua consumindo somente a Edge Function.

CREATE OR REPLACE FUNCTION public.claim_tv_tecnicos_premiacao_cache(
  p_ano integer,
  p_mes integer,
  p_ttl_seconds integer DEFAULT 900
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text := p_ano::text || '-' || lpad(p_mes::text, 2, '0');
  v_row public.tv_tecnicos_premiacao_cache%ROWTYPE;
  v_ttl interval := make_interval(secs => greatest(p_ttl_seconds, 60));
BEGIN
  IF p_mes < 1 OR p_mes > 12 THEN
    RAISE EXCEPTION 'Mês inválido: %', p_mes;
  END IF;

  INSERT INTO public.tv_tecnicos_premiacao_cache (cache_key, ano, mes)
  VALUES (v_key, p_ano, p_mes)
  ON CONFLICT (cache_key) DO NOTHING;

  SELECT * INTO v_row
  FROM public.tv_tecnicos_premiacao_cache
  WHERE cache_key = v_key
  FOR UPDATE;

  IF v_row.payload IS NOT NULL
     AND v_row.refreshed_at >= now() - v_ttl THEN
    RETURN jsonb_build_object(
      'state', 'fresh',
      'payload', v_row.payload,
      'refreshed_at', v_row.refreshed_at
    );
  END IF;

  -- Evita stampede: uma segunda TV não repete o fanout enquanto a primeira
  -- estiver atualizando. Após 2 minutos, uma trava abandonada pode ser retomada.
  IF v_row.refreshing
     AND v_row.refresh_started_at >= now() - interval '2 minutes' THEN
    RETURN jsonb_build_object(
      'state', 'refreshing',
      'payload', v_row.payload,
      'refreshed_at', v_row.refreshed_at
    );
  END IF;

  UPDATE public.tv_tecnicos_premiacao_cache
  SET refreshing = true,
      refresh_started_at = now(),
      updated_at = now()
  WHERE cache_key = v_key;

  RETURN jsonb_build_object(
    'state', 'claimed',
    'payload', v_row.payload,
    'refreshed_at', v_row.refreshed_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_tv_tecnicos_premiacao_cache(integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_tv_tecnicos_premiacao_cache(integer, integer, integer) TO service_role;
