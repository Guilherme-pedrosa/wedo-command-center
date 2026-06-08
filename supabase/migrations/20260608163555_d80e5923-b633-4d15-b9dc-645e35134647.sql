DROP TRIGGER IF EXISTS trg_repricing_on_cost_change ON public.gc_produtos_cache;

COMMENT ON FUNCTION public.fn_trigger_repricing_on_cost_change() IS 'Desativada em 2026-06-08: preço no GC só deve ser alterado por ação manual explícita do usuário no botão de ajuste.';