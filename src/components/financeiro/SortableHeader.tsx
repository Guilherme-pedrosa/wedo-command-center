import { useState } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SortDirection = "asc" | "desc" | null;
export type SortConfig = { key: string; direction: SortDirection };

interface SortableHeaderProps {
  label: string;
  sortKey: string;
  currentSort: SortConfig;
  onSort: (key: string) => void;
  className?: string;
}

export function SortableHeader({ label, sortKey, currentSort, onSort, className }: SortableHeaderProps) {
  const isActive = currentSort.key === sortKey;
  return (
    <th
      className={cn(
        "p-3 text-xs font-medium text-muted-foreground uppercase cursor-pointer select-none hover:text-foreground transition-colors",
        className
      )}
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          currentSort.direction === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        )}
      </span>
    </th>
  );
}

export function useSortConfig(defaultKey = "data_vencimento", defaultDir: SortDirection = "asc") {
  const [sort, setSort] = useState<SortConfig>({ key: defaultKey, direction: defaultDir });

  const handleSort = (key: string) => {
    setSort(prev => {
      if (prev.key === key) {
        if (prev.direction === "asc") return { key, direction: "desc" as SortDirection };
        if (prev.direction === "desc") return { key: "", direction: null };
        return { key, direction: "asc" as SortDirection };
      }
      return { key, direction: "asc" as SortDirection };
    });
  };

  const sortFn = <T extends Record<string, any>>(data: T[]): T[] => {
    if (!sort.key || !sort.direction) return data;
    return [...data].sort((a, b) => {
      let va = a[sort.key];
      let vb = b[sort.key];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") {
        return sort.direction === "asc" ? va - vb : vb - va;
      }
      const sa = String(va).toLowerCase();
      const sb = String(vb).toLowerCase();
      const cmp = sa.localeCompare(sb);
      return sort.direction === "asc" ? cmp : -cmp;
    });
  };

  return { sort, handleSort, sortFn };
}
