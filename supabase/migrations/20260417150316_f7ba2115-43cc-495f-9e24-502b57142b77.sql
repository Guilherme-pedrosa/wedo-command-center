-- Remove 2 órfãos PCM (Sodexo) que foram cancelados/excluídos no GestãoClick
-- mas permaneceram em gc_recebimentos (última sync: 16/03, GC já não retorna mais).
DELETE FROM gc_recebimentos WHERE gc_id IN ('474894156','474911743');