-- [1] Compra antecipada: pagamento liquidado antes da NF chegar
ALTER TABLE fin_pagamentos
  ADD COLUMN IF NOT EXISTS aguardando_nf BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS nfe_chave TEXT,
  ADD COLUMN IF NOT EXISTS nfe_vinculada_em TIMESTAMPTZ;

-- [2] NF nos recebimentos (referência protegida)
ALTER TABLE fin_recebimentos
  ADD COLUMN IF NOT EXISTS nfe_chave TEXT,
  ADD COLUMN IF NOT EXISTS nfe_numero TEXT;

-- [3] Snapshot de OS no agrupamento (nunca perder o original)
ALTER TABLE fin_grupo_receber_itens
  ADD COLUMN IF NOT EXISTS os_codigo_original TEXT,
  ADD COLUMN IF NOT EXISTS gc_os_id TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_valor NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS snapshot_data DATE;

-- [4] Trigger: proteger os_codigo em fin_recebimentos contra limpeza acidental via sync GC
CREATE OR REPLACE FUNCTION fn_preserve_os_ref()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.os_codigo IS NOT NULL AND NEW.os_codigo IS NULL THEN
    NEW.os_codigo := OLD.os_codigo;
  END IF;
  IF OLD.gc_codigo IS NOT NULL AND NEW.gc_codigo IS NULL THEN
    NEW.gc_codigo := OLD.gc_codigo;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_preserve_os_ref ON fin_recebimentos;
CREATE TRIGGER trg_preserve_os_ref
BEFORE UPDATE ON fin_recebimentos
FOR EACH ROW EXECUTE FUNCTION fn_preserve_os_ref();