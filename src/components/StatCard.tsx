import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { LucideIcon } from "lucide-react";

interface StatCardProps {
  title: string;
  value: number;
  count: number;
  icon: LucideIcon;
  color: "blue" | "green" | "orange" | "red" | "purple";
}

const colorMap = {
  blue: "bg-wedo-blue/10 text-wedo-blue border-wedo-blue/20",
  green: "bg-wedo-green/10 text-wedo-green border-wedo-green/20",
  orange: "bg-wedo-orange/10 text-wedo-orange border-wedo-orange/20",
  red: "bg-wedo-red/10 text-wedo-red border-wedo-red/20",
  purple: "bg-wedo-purple/10 text-wedo-purple border-wedo-purple/20",
};

const iconBg = {
  blue: "bg-wedo-blue/20",
  green: "bg-wedo-green/20",
  orange: "bg-wedo-orange/20",
  red: "bg-wedo-red/20",
  purple: "bg-wedo-purple/20",
};

export function StatCard({ title, value, count, icon: Icon, color }: StatCardProps) {
  return (
    <div className={cn("rounded-lg border p-4 transition-colors", colorMap[color])}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium uppercase tracking-wider opacity-80">{title}</span>
        <div className={cn("rounded-md p-1.5", iconBg[color])}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <div className="text-2xl font-bold">{formatCurrency(value)}</div>
      <div className="text-xs mt-1 opacity-70">{count} lançamento{count !== 1 ? "s" : ""}</div>
    </div>
  );
}
