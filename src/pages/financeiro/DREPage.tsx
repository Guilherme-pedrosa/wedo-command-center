import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/format";
import { BarChart3, Download } from "lucide-react";

export default function DREPage() {
  const [ano, setAno] = useState(String(new Date().getFullYear()));

  const { data: recebimentos } = useQuery({
    queryKey: ["dre-recebimentos", ano],
    queryFn: async () => {
      const { data } = await supabase.from("fin_recebimentos")
        .select("valor, data_liquidacao, liquidado, status")
        .eq("liquidado", true)
        .gte("data_liquidacao", `${ano}-01-01`)
        .lte("data_liquidacao", `${ano}-12-31`);
      return data || [];
    },
  });

  const { data: pagamentos } = useQuery({
    queryKey: ["dre-pagamentos", ano],
    queryFn: async () => {
      const { data } = await supabase.from("fin_pagamentos")
        .select("valor, data_liquidacao, liquidado, status")
        .eq("liquidado", true)
        .gte("data_liquidacao", `${ano}-01-01`)
        .lte("data_liquidacao", `${ano}-12-31`);
      return data || [];
    },
  });

  const receitaBruta = recebimentos?.reduce((s, r: any) => s + Number(r.valor || 0), 0) || 0;
  const despesaTotal = pagamentos?.reduce((s, p: any) => s + Number(p.valor || 0), 0) || 0;
  const lucroLiquido = receitaBruta - despesaTotal;
  const margem = receitaBruta > 0 ? (lucroLiquido / receitaBruta) * 100 : 0;

  const DRELine = ({ label, value, bold, indent, negative, isPercent }: { label: string; value: number; bold?: boolean; indent?: boolean; negative?: boolean; isPercent?: boolean }) => (
    <div className={`flex justify-between py-3 px-4 ${bold ? "font-bold border-t border-border bg-muted/30" : ""} ${indent ? "pl-8" : ""}`}>
      <span className={`text-sm ${bold ? "text-foreground" : "text-muted-foreground"}`}>
        {negative ? `(-) ${label}` : label.startsWith("(") ? label : `(+) ${label}`}
      </span>
      <span className={`text-sm font-mono ${value < 0 ? "text-destructive" : bold ? "text-foreground" : "text-muted-foreground"}`}>
        {isPercent ? `${value.toFixed(1)}%` : formatCurrency(Math.abs(value))}
      </span>
    </div>
  );

  const qtdRecebimentos = recebimentos?.length || 0;
  const qtdPagamentos = pagamentos?.length || 0;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">DRE</h1>
          <p className="text-sm text-muted-foreground">Demonstração do Resultado do Exercício</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={ano} onValueChange={setAno}>
            <SelectTrigger className="w-[100px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="2024">2024</SelectItem>
              <SelectItem value="2025">2025</SelectItem>
              <SelectItem value="2026">2026</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Download className="h-3.5 w-3.5 mr-1.5" />Exportar
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="p-4 border-b border-border bg-muted/50">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />DRE Simplificado — {ano}
          </h3>
        </div>

        <DRELine label={`RECEITAS (${qtdRecebimentos} liquidados)`} value={receitaBruta} bold />
        <DRELine label={`DESPESAS (${qtdPagamentos} liquidados)`} value={despesaTotal} negative bold />
        
        <div className="border-t-2 border-border" />
        
        <DRELine label="RESULTADO LÍQUIDO" value={lucroLiquido} bold />
        
        <div className="p-4 border-t border-border bg-muted/30 flex justify-between text-sm">
          <span className="text-muted-foreground">Margem Líquida</span>
          <span className={`font-bold ${margem >= 0 ? "text-chart-2" : "text-destructive"}`}>
            {margem.toFixed(1)}%
          </span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        * DRE simplificado baseado exclusivamente em lançamentos com status <strong>liquidado</strong> no período. 
        Boletos pendentes ou não pagos não são considerados.
      </p>
    </div>
  );
}
