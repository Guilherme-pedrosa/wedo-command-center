import { useDroppable } from "@dnd-kit/core";
import { KanbanCard } from "./KanbanCard";
import type { Tarefa } from "./KanbanBoard";
import { cn } from "@/lib/utils";

interface Props {
  id: string;
  label: string;
  tarefas: Tarefa[];
  count: number;
}

const COL_COLORS: Record<string, string> = {
  a_fazer: "border-t-blue-500",
  em_analise: "border-t-yellow-500",
  aguardando_aprovacao: "border-t-orange-500",
  executando: "border-t-purple-500",
  concluido: "border-t-emerald-500",
  bloqueado: "border-t-red-500",
};

export function KanbanColumn({ id, label, tarefas, count }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex-shrink-0 w-72 rounded-lg border border-t-4 bg-muted/30 flex flex-col",
        COL_COLORS[id] || "border-t-muted-foreground",
        isOver && "ring-2 ring-primary/40"
      )}
    >
      <div className="px-3 py-2 flex items-center justify-between border-b">
        <span className="text-sm font-semibold">{label}</span>
        <span className="text-xs bg-muted rounded-full px-2 py-0.5">{count}</span>
      </div>
      <div className="flex-1 p-2 space-y-2 overflow-y-auto max-h-[65vh]">
        {tarefas.map((t) => (
          <KanbanCard key={t.id} tarefa={t} />
        ))}
        {tarefas.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">Nenhuma tarefa</p>
        )}
      </div>
    </div>
  );
}
