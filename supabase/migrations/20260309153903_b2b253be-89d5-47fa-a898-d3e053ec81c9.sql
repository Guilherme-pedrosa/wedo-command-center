CREATE UNIQUE INDEX IF NOT EXISTS fin_formas_pagamento_gc_id_unique 
ON public.fin_formas_pagamento (gc_id) WHERE gc_id IS NOT NULL;