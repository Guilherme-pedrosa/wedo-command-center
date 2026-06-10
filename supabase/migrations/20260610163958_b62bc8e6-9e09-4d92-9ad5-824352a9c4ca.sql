
ALTER TABLE public.auvo_expenses_sync
  ADD COLUMN IF NOT EXISTS ai_validation_status TEXT,
  ADD COLUMN IF NOT EXISTS ai_validation_notes TEXT,
  ADD COLUMN IF NOT EXISTS ai_extracted_value NUMERIC,
  ADD COLUMN IF NOT EXISTS ai_extracted_merchant TEXT,
  ADD COLUMN IF NOT EXISTS ai_extracted_category TEXT,
  ADD COLUMN IF NOT EXISTS ai_validated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_auvo_expenses_sync_ai_status ON public.auvo_expenses_sync(ai_validation_status);
