import { useDraggable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import type { Tarefa } from "./KanbanBoard";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, DollarSign, FileText } from "lucide-react";

const SEV_COLORS: Record<string, string> = {
  critica: "bg-red-500/20 text-red-400 border-red-500/30",
  alta: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  media: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  baixa: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  info: "bg-muted text-muted-foreground",
};

const TIPO_LABELS: Record<string, string> = {
  ap: "Contas a Pagar",
  ar: "Contas a Receber",
  conciliacao: "Conciliação",
  compras: "Compras",
  orcamentos: "Orçamentos",
  compliance: "Compliance",
  coleta_dado: "Coleta de Dado",
  geral: "Geral",
};

interface Props {
  tarefa: Tarefa;
  isDragging?: boolean;
}

export function KanbanCard({ tarefa, isDragging }: Props) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: tarefa.id,
  });

  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={style}
      className={cn(
        "rounded-md border bg-card p-3 space-y-2 cursor-grab active:cursor-grabbing shadow-sm hover:shadow-md transition-shadow",
        isDragging && "opacity-50 rotate-2 shadow-lg"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium leading-tight">{tarefa.titulo}</span>
        {tarefa.severidade && tarefa.severidade !== "info" && (
          <AlertTriangle className={cn("h-4 w-4 shrink-0", tarefa.severidade === "critica" ? "text-red-400" : "text-yellow-400")} />
        )}
      </div>

      <div className="flex flex-wrap gap-1">
        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
          {TIPO_LABELS[tarefa.tipo] || tarefa.tipo}
        </Badge>
        {tarefa.severidade && (
          <Badge className={cn("text-[10px] px-1.5 py-0 border", SEV_COLORS[tarefa.severidade] || SEV_COLORS.info)}>
            {tarefa.severidade}
          </Badge>
        )}
      </div>

      {(tarefa.valor_impacto ?? 0) > 0 && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <DollarSign className="h-3 w-3" />
          <span>Impacto: R$ {(tarefa.valor_impacto ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
        </div>
      )}

      {tarefa.os_codigo && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <FileText className="h-3 w-3" />
          <span>OS {tarefa.os_codigo}</span>
        </div>
      )}

      {tarefa.descricao && (
        <p className="text-xs text-muted-foreground line-clamp-2">{tarefa.descricao}</p>
      )}
    </div>
  );
}
