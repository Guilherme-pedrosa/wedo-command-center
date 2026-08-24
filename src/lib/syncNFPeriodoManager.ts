// Gerenciador singleton do sync de NFs por período.
// Roda em background (nível de módulo) e persiste último resultado em localStorage.
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import toast from "react-hot-toast";
import { reindexNfeXmlsEmLotes } from "@/lib/reindexNfeXmls";

export interface SyncNFEstado {
  running: boolean;
  startedAt: string | null;
  progress: string;
  lastFinishedAt: string | null;
  lastResult: {
    compras: number;
    produtos: number;
    xmls: number;
    pendentes: number;
    picker_descartes: number;
    fretes_processados: number;
    fretes_ignorados: number;
    frete_valor_total: number;
    dataInicio: string;
    dataFim: string;
    apenasSemNf: boolean;
  } | null;
  lastError: string | null;
}

const STORAGE_KEY = "sync_nf_periodo_estado_v1";

function load(): SyncNFEstado {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // se reload durante execução, considera não-rodando
      return { ...parsed, running: false, progress: "" };
    }
  } catch {}
  return {
    running: false,
    startedAt: null,
    progress: "",
    lastFinishedAt: null,
    lastResult: null,
    lastError: null,
  };
}

let estado: SyncNFEstado = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(estado));
  } catch {}
}

function update(patch: Partial<SyncNFEstado>) {
  estado = { ...estado, ...patch };
  persist();
  for (const l of listeners) l();
}

export function subscribeSyncNF(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSyncNFEstado(): SyncNFEstado {
  return estado;
}

export interface StartSyncParams {
  dataInicio: Date;
  dataFim: Date;
  apenasSemNf: boolean;
  onDone?: () => void;
}

export function startSyncNFPeriodo(params: StartSyncParams): boolean {
  if (estado.running) return false;
  update({
    running: true,
    startedAt: new Date().toISOString(),
    progress: "Iniciando...",
    lastError: null,
  });

  const diStr = format(params.dataInicio, "yyyy-MM-dd");
  const dfStr = format(params.dataFim, "yyyy-MM-dd");

  (async () => {
    try {
      update({ progress: "Sincronizando pedidos GC do período..." });
      const { data: comprasSync, error: comprasSyncErr } = await supabase.functions.invoke("sync-compras", {
        body: { data_inicio: diStr, data_fim: dfStr },
      });
      if (comprasSyncErr) throw new Error(comprasSyncErr.message);

      update({ progress: "Indexando XMLs em lotes de até 1.000..." });
      await reindexNfeXmlsEmLotes((p) => {
        update({ progress: `Indexação lote ${p.lote}: ${p.indexados} indexados, ${p.restantes} restantes` });
      });

      let offset = 0;
      const batchSize = 60;
      let totalCompras = Number(comprasSync?.upserted || comprasSync?.totalFetched || 0);
      let totalProdutos = 0;
      let totalXmls = 0;
      let totalPendentes = 0;
      let totalDescartes = 0;

      while (true) {
        const { data, error } = await supabase.functions.invoke("sync-nfe-entrada", {
          body: {
            offset,
            batch_size: batchSize,
            data_inicio: diStr,
            data_fim: dfStr,
            apenas_sem_nf: params.apenasSemNf,
            skip_reindex: true,
          },
        });
        if (error) throw new Error(error.message);

        totalCompras = data.total_compras || totalCompras;
        totalProdutos += data.upserted || 0;
        totalXmls += data.xmls_lidos || 0;
        totalPendentes += data.pendentes_registrados || 0;
        totalDescartes += data.picker_descartes || 0;
        const processed = Math.min(offset + (data.processed || 0), totalCompras);
        update({ progress: `${processed}/${totalCompras} pedidos processados` });

        if (!data.has_more) break;
        offset = data.next_offset;
      }

      update({ progress: "Rateando fretes do período..." });
      let fretesProcessados = 0;
      let fretesIgnorados = 0;
      let freteValorTotal = 0;
      try {
        const { data: freteData, error: freteErr } = await supabase.functions.invoke("ratear-frete-compras", {
          body: { data_inicio: diStr, data_fim: dfStr },
        });
        if (freteErr) throw new Error(freteErr.message);
        fretesProcessados = freteData?.fretes_processados || 0;
        fretesIgnorados = freteData?.ja_aplicados_ignorados || 0;
        freteValorTotal = freteData?.total_rateado || 0;
        // Aviso de frete duplicado (embutido + externo no mesmo pedido)
        const conflitos = freteData?.conflitos_frete_duplicado || [];
        const bloqueadosEmb = freteData?.frete_embutido_bloqueado_por_externo || 0;
        if (conflitos.length > 0 || bloqueadosEmb > 0) {
          const detalhe = conflitos
            .slice(0, 3)
            .map((c: any) => `#${c.compra_com_frete_embutido} (frete externo #${c.frete_externo_codigo})`)
            .join(", ");
          toast(
            `⚠️ Frete duplicado detectado em ${conflitos.length + bloqueadosEmb} pedido(s)` +
              (detalhe ? `: ${detalhe}${conflitos.length > 3 ? "..." : ""}` : "") +
              ". Frete embutido foi ignorado — corrija no GC para evitar duplicidade.",
            { duration: 12000, icon: "⚠️" },
          );

        }
      } catch (fe) {
        console.warn("Falha no rateio de frete:", fe);
      }


      update({
        running: false,
        progress: "",
        startedAt: null,
        lastFinishedAt: new Date().toISOString(),
        lastResult: {
          compras: totalCompras,
          produtos: totalProdutos,
          xmls: totalXmls,
          pendentes: totalPendentes,
          picker_descartes: totalDescartes,
          fretes_processados: fretesProcessados,
          fretes_ignorados: fretesIgnorados,
          frete_valor_total: freteValorTotal,
          dataInicio: diStr,
          dataFim: dfStr,
          apenasSemNf: params.apenasSemNf,
        },
        lastError: null,
      });
      toast.success(
        `Sync concluído: ${totalProdutos} produto(s) de ${totalCompras} pedido(s)` +
          (fretesProcessados > 0 ? ` • ${fretesProcessados} frete(s) rateado(s)` : ""),
      );
      params.onDone?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      update({
        running: false,
        progress: "",
        startedAt: null,
        lastFinishedAt: new Date().toISOString(),
        lastError: msg,
      });
      toast.error(`Sync falhou: ${msg}`);
    }
  })();

  return true;
}
