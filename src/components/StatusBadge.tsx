import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const statusConfig: Record<string, { label: string; className: string }> = {
  aberto: { label: "Aberto", className: "bg-muted text-muted-foreground" },
  aguardando_pagamento: { label: "Aguardando Pagamento", className: "bg-wedo-blue/20 text-wedo-blue border-wedo-blue/30" },
  pago: { label: "Pago", className: "bg-wedo-green/20 text-wedo-green border-wedo-green/30" },
  pago_parcial: { label: "Pago Parcial", className: "bg-wedo-orange/20 text-wedo-orange border-wedo-orange/30" },
  cancelado: { label: "Cancelado", className: "bg-wedo-red/20 text-wedo-red border-wedo-red/30" },
  agendado: { label: "Agendado", className: "bg-wedo-purple/20 text-wedo-purple border-wedo-purple/30" },
  processando: { label: "Processando", className: "bg-wedo-yellow/20 text-wedo-yellow border-wedo-yellow/30" },
  erro: { label: "Erro", className: "bg-wedo-red/20 text-wedo-red border-wedo-red/30" },
  sucesso: { label: "Sucesso", className: "bg-wedo-green/20 text-wedo-green border-wedo-green/30" },
  pendente: { label: "Pendente", className: "bg-wedo-orange/20 text-wedo-orange border-wedo-orange/30" },
};

interface StatusBadgeProps {
  status: string;
  pulse?: boolean;
  className?: string;
}

export function StatusBadge({ status, pulse, className }: StatusBadgeProps) {
  const config = statusConfig[status] || { label: status, className: "bg-muted text-muted-foreground" };
  return (
    <Badge variant="outline" className={cn("text-xs font-medium border", config.className, className)}>
      {pulse && <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current animate-pulse-dot inline-block" />}
      {config.label}
    </Badge>
  );
}
