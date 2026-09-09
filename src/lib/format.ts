import { format, formatDistanceToNow, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

export function formatDate(date: string | Date): string {
  // A due date has no time zone. Parsing YYYY-MM-DD as UTC moves it to the
  // previous day in Brazil; real timestamps must still use the local zone.
  const value = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? parseISO(date) : new Date(date);
  return format(value, "dd/MM/yyyy", { locale: ptBR });
}

export function formatDateTime(date: string | Date): string {
  return format(new Date(date), "dd/MM/yyyy HH:mm", { locale: ptBR });
}

export function formatTimeAgo(date: string | Date): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true, locale: ptBR });
}
