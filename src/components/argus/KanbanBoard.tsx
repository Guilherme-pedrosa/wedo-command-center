import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { KanbanColumn } from "./KanbanColumn";
import { KanbanCard } from "./KanbanCard";
import { Button } from "@/components/ui/button";
import { Plus, RefreshCw } from "lucide-react";
import { TarefaDialog } from "./TarefaDialog";
import toast from "react-hot-toast";

const COLUNAS = [
  { id: "a_fazer", label: "A Fazer" },
  { id: "em_analise", label: "Em Análise" },
  { id: "aguardando_aprovacao", label: "Aguardando Aprovação" },
  { id: "executando", label: "Executando" },
  { id: "concluido", label: "Concluído" },
  { id: "bloqueado", label: "Bloqueado" },
];

export type Tarefa = {
  id: string;
  titulo: string;
  descricao: string | null;
  tipo: string;
  coluna: string;
  posicao: number;
  severidade: string | null;
  valor_impacto: number | null;
  entidade_tipo: string | null;
  entidade_id: string | null;
  os_codigo: string | null;
  evidencias: any;
  plano_acao: any;
  atribuido_a: string | null;
  created_by: string | null;
  created_at: string | null;
};

export function KanbanBoard() {
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const { data: tarefas = [], isLoading } = useQuery({
    queryKey: ["fin_tarefas"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fin_tarefas")
        .select("*")
        .order("posicao", { ascending: true });
      if (error) throw error;
      return data as Tarefa[];
    },
  });

  const moveTarefa = useMutation({
    mutationFn: async ({ id, coluna }: { id: string; coluna: string }) => {
      const { error } = await supabase
        .from("fin_tarefas")
        .update({ coluna, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fin_tarefas"] }),
    onError: () => toast.error("Erro ao mover tarefa"),
  });

  const tarefasPorColuna = useMemo(() => {
    const map: Record<string, Tarefa[]> = {};
    COLUNAS.forEach((c) => (map[c.id] = []));
    tarefas.forEach((t) => {
      if (map[t.coluna]) map[t.coluna].push(t);
      else map["a_fazer"]?.push(t);
    });
    return map;
  }, [tarefas]);

  const activeTarefa = tarefas.find((t) => t.id === activeId);

  function handleDragStart(e: DragStartEvent) {
    setActiveId(e.active.id as string);
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;

    const overId = over.id as string;
    const coluna = COLUNAS.find((c) => c.id === overId);
    if (coluna && active.id !== overId) {
      moveTarefa.mutate({ id: active.id as string, coluna: coluna.id });
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> Nova Tarefa
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => qc.invalidateQueries({ queryKey: ["fin_tarefas"] })}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-3 overflow-x-auto pb-4" style={{ minHeight: 500 }}>
          {COLUNAS.map((col) => (
            <KanbanColumn
              key={col.id}
              id={col.id}
              label={col.label}
              tarefas={tarefasPorColuna[col.id] || []}
              count={tarefasPorColuna[col.id]?.length || 0}
            />
          ))}
        </div>
        <DragOverlay>
          {activeTarefa ? <KanbanCard tarefa={activeTarefa} isDragging /> : null}
        </DragOverlay>
      </DndContext>

      <TarefaDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
