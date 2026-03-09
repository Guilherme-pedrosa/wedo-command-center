-- Fix: add composite unique index that the sync-os edge function expects for upsert
CREATE UNIQUE INDEX IF NOT EXISTS os_index_os_id_orc_codigo_idx 
ON public.os_index (os_id, orc_codigo);

-- Drop the old single-column index that's insufficient for the upsert
DROP INDEX IF EXISTS os_index_orc_codigo_idx;