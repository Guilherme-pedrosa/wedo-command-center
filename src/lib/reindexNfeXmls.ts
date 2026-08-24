import { supabase } from "@/integrations/supabase/client";

export interface ReindexNfeXmlProgress {
  lote: number;
  listados: number;
  pendentesAntes: number;
  tentados: number;
  indexados: number;
  falhas: number;
  restantes: number;
}

/**
 * Reindexa o bucket de NF-e em páginas de até 1.000 arquivos até esgotar.
 * O limite por chamada evita depender do teto padrão do Storage/PostgREST.
 */
export async function reindexNfeXmlsEmLotes(
  onProgress?: (progress: ReindexNfeXmlProgress) => void,
): Promise<{ lotes: number; indexados: number; falhas: number; listados: number }> {
  const batchSize = 1000;
  const maxLotes = 50;
  let lote = 0;
  let totalIndexados = 0;
  let totalFalhas = 0;
  let totalListados = 0;

  while (lote < maxLotes) {
    lote++;
    const { data, error } = await supabase.functions.invoke("sync-nfe-entrada", {
      body: {
        reindex_only: true,
        reindex_batch_size: batchSize,
      },
    });
    if (error) throw new Error(error.message);

    const stats = data?.reindex_stats || {};
    const progress: ReindexNfeXmlProgress = {
      lote,
      listados: Number(stats.listed || 0),
      pendentesAntes: Number(stats.missing || 0),
      tentados: Number(stats.attempted || 0),
      indexados: Number(stats.indexed || 0),
      falhas: Number(stats.failed || 0),
      restantes: Number(stats.remaining || 0),
    };

    totalListados = Math.max(totalListados, progress.listados);
    totalIndexados += progress.indexados;
    totalFalhas += progress.falhas;
    onProgress?.(progress);

    if (!data?.reindex_has_more) {
      return { lotes: lote, indexados: totalIndexados, falhas: totalFalhas, listados: totalListados };
    }
  }

  throw new Error(`Reindexação de NF-e excedeu ${maxLotes} lotes de ${batchSize} arquivos.`);
}
