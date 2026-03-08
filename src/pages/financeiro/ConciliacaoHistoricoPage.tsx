import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { CheckCircle, Search, Eye, ArrowLeftRight, TrendingUp, TrendingDown, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ConciliacaoHistoricoPage() {
  const [search, setSearch] = useState("");
  const [tipoFilter, setTipoFilter] = useState<string>("todos");
  const [vinculoFilter, setVinculoFilter] = useState<string>("todos");
  const [detail, setDetail] = useState<any>(null);

  // Fetch reconciled extrato
  const { data: items, isLoading } = useQuery({
    queryKey: ["conciliacao-historico"],
    queryFn: async () => {
      const { data } = await supabase
        .from("vw_conciliacao_extrato" as any)
        .select("*")
        .eq("reconciliado", true)
        .order("reconciliado_em", { ascending: false })
        .limit(500);
      return (data as any[]) || [];
    },
  });

  // Fetch linked lancamentos (recebimentos + pagamentos) in bulk
  const lancIds = (items || []).map((i: any) => i.lancamento_id).filter(Boolean);
  const grupoRecIds = (items || []).map((i: any) => i.grupo_receber_id).filter(Boolean);
  const grupoPagIds = (items || []).map((i: any) => i.grupo_pagar_id).filter(Boolean);

  const { data: recebimentos } = useQuery({
    queryKey: ["conc-hist-rec", lancIds.join(",")],
    queryFn: async () => {
      if (!lancIds.length) return [];
      const { data } = await supabase
        .from("fin_recebimentos")
        .select("id, descricao, valor, nome_cliente, data_vencimento, data_liquidacao, status, gc_codigo, os_codigo, plano_contas_id, centro_custo_id, origem")
        .in("id", lancIds);
      return data || [];
    },
    enabled: lancIds.length > 0,
  });

  const { data: pagamentos } = useQuery({
    queryKey: ["conc-hist-pag", lancIds.join(",")],
    queryFn: async () => {
      if (!lancIds.length) return [];
      const { data } = await supabase
        .from("fin_pagamentos")
        .select("id, descricao, valor, nome_fornecedor, data_vencimento, data_liquidacao, status, gc_codigo, os_codigo, plano_contas_id, centro_custo_id, origem")
        .in("id", lancIds);
      return data || [];
    },
    enabled: lancIds.length > 0,
  });

  const { data: gruposReceber } = useQuery({
    queryKey: ["conc-hist-grp-rec", grupoRecIds.join(",")],
    queryFn: async () => {
      if (!grupoRecIds.length) return [];
      const { data } = await supabase
        .from("fin_grupos_receber")
        .select("id, nome, valor_total, nome_cliente, status")
        .in("id", grupoRecIds);
      return data || [];
    },
    enabled: grupoRecIds.length > 0,
  });

  const { data: gruposPagar } = useQuery({
    queryKey: ["conc-hist-grp-pag", grupoPagIds.join(",")],
    queryFn: async () => {
      if (!grupoPagIds.length) return [];
      const { data } = await supabase
        .from("fin_grupos_pagar")
        .select("id, nome, valor_total, nome_fornecedor, status")
        .in("id", grupoPagIds);
      return data || [];
    },
    enabled: grupoPagIds.length > 0,
  });

  // Fetch sync_log entries for conciliation
  const { data: syncLogs } = useQuery({
    queryKey: ["conc-hist-logs"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_sync_log")
        .select("*")
        .in("tipo", ["conciliacao_auto", "inter_webhook_recebimento", "inter_webhook_pagamento"])
        .order("created_at", { ascending: false })
        .limit(500);
      return data || [];
    },
  });

  // Build lookup maps
  const recMap: Record<string, any> = {};
  (recebimentos || []).forEach((r: any) => { recMap[r.id] = r; });
  const pagMap: Record<string, any> = {};
  (pagamentos || []).forEach((p: any) => { pagMap[p.id] = p; });
  const grpRecMap: Record<string, any> = {};
  (gruposReceber || []).forEach((g: any) => { grpRecMap[g.id] = g; });
  const grpPagMap: Record<string, any> = {};
  (gruposPagar || []).forEach((g: any) => { grpPagMap[g.id] = g; });
  const logByRef: Record<string, any> = {};
  (syncLogs || []).forEach((l: any) => { if (l.referencia_id) logByRef[l.referencia_id] = l; });

  const getLancamento = (item: any) => {
    if (item.lancamento_id) return recMap[item.lancamento_id] || pagMap[item.lancamento_id] || null;
    return null;
  };

  const getGrupo = (item: any) => {
    if (item.grupo_receber_id) return { ...grpRecMap[item.grupo_receber_id], _tipo: "receber" };
    if (item.grupo_pagar_id) return { ...grpPagMap[item.grupo_pagar_id], _tipo: "pagar" };
    return null;
  };

  const getVinculoLabel = (item: any) => {
    if (item.lancamento_id) return "lancamento";
    if (item.grupo_receber_id) return "grupo_receber";
    if (item.grupo_pagar_id) return "grupo_pagar";
    return "manual";
  };

  const filtered = (items || []).filter((i: any) => {
    if (tipoFilter !== "todos" && i.tipo !== tipoFilter) return false;
    const vinculo = getVinculoLabel(i);
    if (vinculoFilter !== "todos" && vinculo !== vinculoFilter) return false;
    if (search) {
      const s = search.toLowerCase();
      const lanc = getLancamento(i);
      const grupo = getGrupo(i);
      return (
        (i.contrapartida ?? "").toLowerCase().includes(s) ||
        (i.cpf_cnpj ?? "").includes(s) ||
        (i.end_to_end_id ?? "").toLowerCase().includes(s) ||
        (i.descricao ?? "").toLowerCase().includes(s) ||
        (lanc?.descricao ?? "").toLowerCase().includes(s) ||
        (lanc?.gc_codigo ?? "").includes(s) ||
        (lanc?.os_codigo ?? "").includes(s) ||
        (grupo?.nome ?? "").toLowerCase().includes(s)
      );
    }
    return true;
  });

  // Stats
  const totalCredito = filtered.filter((i: any) => i.tipo === "CREDITO").reduce((s: number, i: any) => s + Math.abs(Number(i.valor_extrato ?? i.valor)), 0);
  const totalDebito = filtered.filter((i: any) => i.tipo === "DEBITO").reduce((s: number, i: any) => s + Math.abs(Number(i.valor_extrato ?? i.valor)), 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Histórico de Conciliação</h1>
        <p className="text-sm text-muted-foreground">Registro detalhado de todas as transações reconciliadas</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="text-[10px] uppercase text-muted-foreground font-semibold">Total Reconciliado</p>
          <p className="text-lg font-bold text-foreground">{filtered.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <TrendingUp className="h-3 w-3 text-wedo-green" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">Créditos</p>
          </div>
          <p className="text-lg font-bold text-wedo-green">{formatCurrency(totalCredito)}</p>
          <p className="text-[10px] text-muted-foreground">{filtered.filter((i: any) => i.tipo === "CREDITO").length} transações</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <TrendingDown className="h-3 w-3 text-wedo-red" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">Débitos</p>
          </div>
          <p className="text-lg font-bold text-wedo-red">{formatCurrency(totalDebito)}</p>
          <p className="text-[10px] text-muted-foreground">{filtered.filter((i: any) => i.tipo === "DEBITO").length} transações</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <ArrowLeftRight className="h-3 w-3 text-primary" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">Saldo Líquido</p>
          </div>
          <p className={`text-lg font-bold ${totalCredito - totalDebito >= 0 ? "text-wedo-green" : "text-wedo-red"}`}>
            {formatCurrency(totalCredito - totalDebito)}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar nome, CPF/CNPJ, E2E ID, descrição, OS, GC código..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={tipoFilter} onValueChange={setTipoFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos tipos</SelectItem>
            <SelectItem value="CREDITO">Crédito</SelectItem>
            <SelectItem value="DEBITO">Débito</SelectItem>
          </SelectContent>
        </Select>
        <Select value={vinculoFilter} onValueChange={setVinculoFilter}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos vínculos</SelectItem>
            <SelectItem value="lancamento">Lançamento</SelectItem>
            <SelectItem value="grupo_receber">Grupo Receber</SelectItem>
            <SelectItem value="grupo_pagar">Grupo Pagar</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-3 w-[70px]">Tipo</th>
                <th className="px-3 py-3">Contrapartida</th>
                <th className="px-3 py-3">CPF/CNPJ</th>
                <th className="px-3 py-3 text-right">Valor Extrato</th>
                <th className="px-3 py-3">Lançamento Vinculado</th>
                <th className="px-3 py-3 text-right">Valor Lanç.</th>
                <th className="px-3 py-3">Diferença</th>
                <th className="px-3 py-3">Data Transação</th>
                <th className="px-3 py-3">Conciliado em</th>
                <th className="px-3 py-3">Método</th>
                <th className="px-3 py-3 w-[50px]"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={11} className="text-center py-8 text-muted-foreground">Carregando...</td></tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={11} className="text-center py-8 text-muted-foreground">Nenhum registro encontrado</td></tr>
              )}
              {filtered.map((item: any) => {
                const lanc = getLancamento(item);
                const grupo = getGrupo(item);
                const valorGc = item.valor_gc != null ? Number(item.valor_gc) : (lanc ? Number(lanc.valor) : grupo ? Number(grupo.valor_total) : null);
                const diff = item.diferenca != null ? Number(item.diferenca) : (valorGc !== null ? Math.abs(Math.abs(Number(item.valor_extrato ?? item.valor)) - valorGc) : null);
                const isExato = item.exato != null ? item.exato : (diff !== null && diff <= 0.02);
                const qtdParcelas = item.qtd_parcelas != null ? Number(item.qtd_parcelas) : null;
                const log = logByRef[item.id];
                const score = log?.payload?.score;
                const reasons = log?.payload?.reasons;
                const metodo = log?.tipo === "conciliacao_auto" ? "Auto" : log?.tipo?.includes("webhook") ? "Webhook" : "Manual";
                const valorExtrato = item.valor_extrato != null ? item.valor_extrato : item.valor;

                return (
                  <tr key={item.id} className="border-b border-border/50 hover:bg-muted/20 cursor-pointer" onClick={() => setDetail({ item, lanc, grupo, log, score, reasons, metodo, valorGc, diff, isExato, qtdParcelas })}>
                    <td className="px-3 py-2.5">
                      <Badge variant="outline" className={`text-[10px] ${item.tipo === "CREDITO" ? "text-wedo-green" : "text-wedo-red"}`}>
                        {item.tipo}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-xs">{item.contrapartida || "—"}</p>
                      {item.chave_pix && <p className="text-[10px] text-muted-foreground">PIX: {item.chave_pix}</p>}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground text-[11px] font-mono">{item.cpf_cnpj || "—"}</td>
                    <td className="px-3 py-2.5 text-right font-semibold">{formatCurrency(Math.abs(Number(valorExtrato)))}</td>
                    <td className="px-3 py-2.5">
                      {lanc && (
                        <div>
                          <p className="text-xs font-medium truncate max-w-[200px]">{lanc.descricao}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {lanc.nome_cliente || lanc.nome_fornecedor || ""}
                            {lanc.gc_codigo && <span className="ml-1">· GC {lanc.gc_codigo}</span>}
                            {lanc.os_codigo && <span className="ml-1">· OS {lanc.os_codigo}</span>}
                          </p>
                        </div>
                      )}
                      {grupo && (
                        <div>
                          <p className="text-xs font-medium truncate max-w-[200px]">{grupo.nome}</p>
                          <p className="text-[10px] text-muted-foreground">{grupo.nome_cliente || grupo.nome_fornecedor || ""}</p>
                        </div>
                      )}
                      {!lanc && !grupo && <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs">
                      {valorGc !== null ? formatCurrency(valorGc) : "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      {diff !== null && (
                        qtdParcelas != null && qtdParcelas > 1 ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant={isExato ? "default" : "destructive"} className="text-[10px] cursor-help">
                                {isExato ? "✓ Exato" : formatCurrency(diff)}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p className="text-xs">{qtdParcelas} parcelas — total GC {formatCurrency(valorGc ?? 0)}</p>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Badge variant={isExato ? "default" : "destructive"} className="text-[10px]">
                            {isExato ? "✓ Exato" : formatCurrency(diff)}
                          </Badge>
                        )
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-[11px] text-muted-foreground whitespace-nowrap">
                      {item.data_hora ? formatDateTime(item.data_hora) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-[11px] text-muted-foreground whitespace-nowrap">
                      {item.reconciliado_em ? formatDateTime(item.reconciliado_em) : "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className={`text-[10px] ${metodo === "Auto" ? "text-wedo-green border-wedo-green/30" : metodo === "Webhook" ? "text-primary border-primary/30" : "text-muted-foreground"}`}>
                          {metodo}
                        </Badge>
                        {score && <span className="text-[10px] text-muted-foreground">S:{score}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0"><Eye className="h-3.5 w-3.5" /></Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="px-4 py-2 text-xs text-muted-foreground border-t border-border flex justify-between">
            <span>{filtered.length} registro(s)</span>
            <span>Créditos: {formatCurrency(totalCredito)} · Débitos: {formatCurrency(totalDebito)}</span>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      <Dialog open={!!detail} onOpenChange={o => { if (!o) setDetail(null); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowLeftRight className="h-4 w-4" />
              Detalhes da Conciliação
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-4 text-sm">
              {/* Extrato */}
              <div className="rounded-md border border-border p-4 space-y-2">
                <h4 className="font-semibold text-xs uppercase text-muted-foreground flex items-center gap-1.5">
                  🏦 Extrato Bancário
                </h4>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Tipo" value={detail.item.tipo} />
                  <Field label="Valor" value={formatCurrency(Math.abs(Number(detail.item.valor)))} className="font-semibold" />
                  <Field label="Contrapartida" value={detail.item.contrapartida} />
                  <Field label="CPF/CNPJ" value={detail.item.cpf_cnpj} mono />
                  <Field label="Chave PIX" value={detail.item.chave_pix} mono />
                  <Field label="End-to-End ID" value={detail.item.end_to_end_id} mono />
                  <Field label="Data/Hora Transação" value={detail.item.data_hora ? formatDateTime(detail.item.data_hora) : "—"} />
                  <Field label="Descrição" value={detail.item.descricao} />
                </div>
              </div>

              {/* Lançamento vinculado */}
              {detail.lanc && (
                <div className="rounded-md border border-border p-4 space-y-2">
                  <h4 className="font-semibold text-xs uppercase text-muted-foreground">📋 Lançamento Vinculado</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Descrição" value={detail.lanc.descricao} />
                    <Field label="Valor" value={formatCurrency(Number(detail.lanc.valor))} className="font-semibold" />
                    <Field label="Cliente/Fornecedor" value={detail.lanc.nome_cliente || detail.lanc.nome_fornecedor} />
                    <Field label="Status" value={detail.lanc.status} />
                    <Field label="Código GC" value={detail.lanc.gc_codigo} mono />
                    <Field label="Código OS" value={detail.lanc.os_codigo} mono />
                    <Field label="Data Vencimento" value={detail.lanc.data_vencimento} />
                    <Field label="Data Liquidação" value={detail.lanc.data_liquidacao} />
                    <Field label="Origem" value={detail.lanc.origem} />
                  </div>
                </div>
              )}

              {/* Grupo vinculado */}
              {detail.grupo && (
                <div className="rounded-md border border-border p-4 space-y-2">
                  <h4 className="font-semibold text-xs uppercase text-muted-foreground">🗂️ Grupo Vinculado</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Nome" value={detail.grupo.nome} />
                    <Field label="Valor Total" value={formatCurrency(Number(detail.grupo.valor_total))} className="font-semibold" />
                    <Field label="Cliente/Fornecedor" value={detail.grupo.nome_cliente || detail.grupo.nome_fornecedor} />
                    <Field label="Status" value={detail.grupo.status} />
                    <Field label="Tipo" value={detail.grupo._tipo === "receber" ? "A Receber" : "A Pagar"} />
                  </div>
                </div>
              )}

              {/* Conciliação info */}
              <div className="rounded-md border border-border p-4 space-y-2">
                <h4 className="font-semibold text-xs uppercase text-muted-foreground">⚙️ Informações da Conciliação</h4>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Método" value={detail.metodo} />
                  <Field label="Conciliado em" value={detail.item.reconciliado_em ? formatDateTime(detail.item.reconciliado_em) : "—"} />
                  {detail.score && <Field label="Score" value={`${detail.score} pts`} />}
                  {detail.reasons?.length > 0 && (
                    <div className="col-span-2">
                      <p className="text-[10px] text-muted-foreground uppercase font-semibold mb-1">Critérios de Match</p>
                      <div className="flex flex-wrap gap-1">
                        {detail.reasons.map((r: string, i: number) => (
                          <Badge key={i} variant="secondary" className="text-[10px]">{r}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Diferença */}
              {detail.lanc && (
                <div className={`rounded-md p-3 text-xs flex items-center gap-2 ${Math.abs(Math.abs(Number(detail.item.valor)) - Number(detail.lanc.valor)) <= 0.01 ? "bg-wedo-green/10 text-wedo-green" : "bg-wedo-orange/10 text-wedo-orange"}`}>
                  <CheckCircle className="h-4 w-4" />
                  {Math.abs(Math.abs(Number(detail.item.valor)) - Number(detail.lanc.valor)) <= 0.01
                    ? "Valores idênticos — match exato"
                    : `Diferença de ${formatCurrency(Math.abs(Math.abs(Number(detail.item.valor)) - Number(detail.lanc.valor)))}`
                  }
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, value, className, mono }: { label: string; value?: string | null; className?: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground uppercase font-semibold">{label}</p>
      <p className={`text-xs ${mono ? "font-mono" : ""} ${className || ""}`}>{value || "—"}</p>
    </div>
  );
}
