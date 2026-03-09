import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { CheckCircle, Search, Eye, ArrowLeftRight, TrendingUp, TrendingDown, AlertTriangle, ExternalLink, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";

const GC_BASE = "https://app.gestaoclick.com.br";
const gcRecebimentoLink = (gcId: string) => `${GC_BASE}/recebimentos/${gcId}`;
const gcPagamentoLink = (gcId: string) => `${GC_BASE}/pagamentos/${gcId}`;

const EXCECAO_RULES = ["SEM_PAR_GC", "TRANSFERENCIA_INTERNA", "PIX_DEVOLVIDO_MANUAL"];

const ruleLabels: Record<string, string> = {
  SEM_PAR_GC: "Sem Par GC",
  TRANSFERENCIA_INTERNA: "Transfer\u00eancia Interna",
  PIX_DEVOLVIDO_MANUAL: "PIX Devolvido",
  LINK_JA_PAGO_GC: "Rastreabilidade",
  MATCH_VALOR_DATA: "Valor + Data",
  MATCH_VALOR_NOME: "Valor + Nome",
  MATCH_GRUPO_RECEBER: "Grupo Receber",
  MATCH_GRUPO_PAGAR: "Grupo Pagar",
  MATCH_AGENDA: "Agenda",
};

export default function ConciliacaoHistoricoPage() {
  const [search, setSearch] = useState("");
  const [tipoFilter, setTipoFilter] = useState<string>("todos");
  const [vinculoFilter, setVinculoFilter] = useState<string>("todos");
  const [detail, setDetail] = useState<any>(null);
  const [tab, setTab] = useState("conciliados");

  // CONCILIADOS REAIS
  const { data: items, isLoading } = useQuery({
    queryKey: ["conciliacao-historico"],
    queryFn: async () => {
      const { data } = await supabase
        .from("vw_conciliacao_extrato" as any)
        .select("*")
        .eq("reconciliado", true)
        .not("reconciliation_rule", "in", '("SEM_PAR_GC","TRANSFERENCIA_INTERNA","PIX_DEVOLVIDO_MANUAL")')
        .order("reconciliado_em", { ascending: false })
        .limit(500);
      return (data as any[]) || [];
    },
  });

  // N\u00c3O CONCILIADO (exce\u00e7\u00f5es classificadas)
  const { data: excecoes, isLoading: isLoadingExc } = useQuery({
    queryKey: ["conciliacao-excecoes"],
    queryFn: async () => {
      const { data } = await supabase
        .from("vw_conciliacao_extrato" as any)
        .select("*")
        .in("reconciliation_rule", EXCECAO_RULES)
        .order("reconciliado_em", { ascending: false })
        .limit(200);
      return (data as any[]) || [];
    },
  });

  // FINANCEIRO N\u00c3O CONCILIADO (sem regra, n\u00e3o reconciliado)
  const { data: financeirosNaoConciliados, isLoading: isLoadingFinNaoConc } = useQuery({
    queryKey: ["conciliacao-financeiro-nao-conciliado"],
    queryFn: async () => {
      const { data } = await supabase
        .from("vw_conciliacao_extrato" as any)
        .select("*")
        .eq("reconciliado", false)
        .is("reconciliation_rule", null)
        .order("data_hora", { ascending: false })
        .limit(200);
      return (data as any[]) || [];
    },
  });

  const searchFilter = (i: any) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      i.nome_contraparte?.toLowerCase().includes(s) ||
      i.cpf_cnpj?.toLowerCase().includes(s) ||
      i.end_to_end_id?.toLowerCase().includes(s) ||
      i.descricao?.toLowerCase().includes(s) ||
      i.chave_pix?.toLowerCase().includes(s) ||
      i.contrapartida?.toLowerCase().includes(s)
    );
  };

  const filtered = (items || [])
    .filter((i: any) => tipoFilter === "todos" || i.tipo === tipoFilter)
    .filter((i: any) => {
      if (vinculoFilter === "todos") return true;
      if (vinculoFilter === "lancamento") return !!i.lancamento_id;
      if (vinculoFilter === "grupo_receber") return !!i.grupo_receber_id;
      if (vinculoFilter === "grupo_pagar") return !!i.grupo_pagar_id;
      if (vinculoFilter === "agenda") return !!i.agenda_id;
      return true;
    })
    .filter(searchFilter);

  const filteredExc = (excecoes || []).filter(searchFilter);
  const filteredFinNaoConc = (financeirosNaoConciliados || []).filter(searchFilter);

  // Stats
  const totalCredito = filtered.filter((i: any) => i.tipo === "CREDITO").reduce((s: number, i: any) => s + Math.abs(Number(i.valor_extrato || 0)), 0);
  const totalDebito = filtered.filter((i: any) => i.tipo === "DEBITO").reduce((s: number, i: any) => s + Math.abs(Number(i.valor_extrato || 0)), 0);
  const totalExcecoes = (excecoes || []).reduce((s: number, i: any) => s + Math.abs(Number(i.valor_extrato || 0)), 0);

  const vinculoBadge = (item: any) => {
    if (item.grupo_receber_id) return <Badge variant="secondary" className="text-[10px]">Grupo Receber</Badge>;
    if (item.grupo_pagar_id) return <Badge variant="secondary" className="text-[10px]">Grupo Pagar</Badge>;
    if (item.agenda_id) return <Badge variant="secondary" className="text-[10px]">Agenda</Badge>;
    if (item.lancamento_id) return <Badge variant="secondary" className="text-[10px]">{`Lan\u00e7amento`}</Badge>;
    return null;
  };

  const diferencaBadge = (item: any) => {
    if (item.exato) return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/30 text-[10px]">Exato</Badge>;
    if (item.diferenca != null && item.diferenca !== 0) {
      const diff = Number(item.diferenca);
      return (
        <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/30 text-[10px]">
          {diff > 0 ? "+" : ""}{formatCurrency(diff)}
        </Badge>
      );
    }
    return null;
  };

  const renderRow = (item: any, showDiferenca = true, showVinculo = true) => (
    <div key={item.id} className="grid grid-cols-12 items-center gap-2 p-3 hover:bg-muted/30 transition-colors">
      {/* Data */}
      <div className="col-span-2 text-xs text-muted-foreground">
        {formatDateTime(item.reconciliado_em || item.data_hora)}
      </div>
      {/* Nome contraparte */}
      <div className="col-span-2 font-medium text-foreground truncate" title={item.nome_contraparte}>
        {item.nome_contraparte || "\u2014"}
      </div>
      {/* CPF/CNPJ */}
      <div className="col-span-1 text-xs text-muted-foreground font-mono truncate" title={item.cpf_cnpj}>
        {item.cpf_cnpj || "\u2014"}
      </div>
      {/* Tipo + V\u00ednculo */}
      <div className="col-span-2 flex flex-wrap items-center gap-1">
        <Badge variant="outline" className="text-[10px]">{item.tipo}</Badge>
        {showVinculo && vinculoBadge(item)}
        {item.reconciliation_rule && !EXCECAO_RULES.includes(item.reconciliation_rule) && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/30">
                  <Link2 className="h-2.5 w-2.5 mr-0.5" />
                  {ruleLabels[item.reconciliation_rule] || item.reconciliation_rule}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Regra: {item.reconciliation_rule}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {/* Valor extrato */}
      <div className="col-span-1 text-right font-bold text-foreground">
        {formatCurrency(Math.abs(Number(item.valor_extrato || 0)))}
      </div>
      {/* Valor GC + Diferen\u00e7a */}
      {showDiferenca ? (
        <div className="col-span-2 flex items-center gap-2">
          {item.valor_gc != null && (
            <span className="text-xs text-muted-foreground">
              GC: {formatCurrency(Number(item.valor_gc))}
            </span>
          )}
          {item.qtd_parcelas != null && item.qtd_parcelas > 1 && (
            <Badge variant="outline" className="text-[10px]">{item.qtd_parcelas}x</Badge>
          )}
          {diferencaBadge(item)}
        </div>
      ) : (
        <div className="col-span-2" />
      )}
      {/* A\u00e7\u00f5es */}
      <div className="col-span-2 flex items-center justify-end gap-1">
        <TooltipProvider>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setDetail(item)}>
            <Eye className="h-3.5 w-3.5" />
          </Button>
        </TooltipProvider>
      </div>
    </div>
  );

  const renderExcRow = (item: any) => (
    <div key={item.id} className="grid grid-cols-12 items-center gap-2 p-3 hover:bg-muted/30 transition-colors">
      <div className="col-span-2 text-xs text-muted-foreground">
        {formatDateTime(item.reconciliado_em || item.data_hora)}
      </div>
      <div className="col-span-2 font-medium text-foreground truncate" title={item.nome_contraparte}>
        {item.nome_contraparte || "\u2014"}
      </div>
      <div className="col-span-1 text-xs text-muted-foreground font-mono truncate">
        {item.cpf_cnpj || "\u2014"}
      </div>
      <div className="col-span-2">
        <Badge variant="destructive" className="text-[10px]">
          {ruleLabels[item.reconciliation_rule] || item.reconciliation_rule}
        </Badge>
      </div>
      <div className="col-span-1 text-right font-bold text-foreground">
        {formatCurrency(Math.abs(Number(item.valor_extrato || 0)))}
      </div>
      <div className="col-span-2 text-xs text-muted-foreground truncate" title={item.descricao}>
        {item.descricao || "\u2014"}
      </div>
      <div className="col-span-2 flex items-center justify-end gap-1">
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setDetail(item)}>
          <Eye className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{`Hist\u00f3rico de Concilia\u00e7\u00e3o`}</h1>
        <p className="text-sm text-muted-foreground">{`Registro detalhado de todas as transa\u00e7\u00f5es reconciliadas`}</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="text-[10px] uppercase text-muted-foreground font-semibold">Total Conciliado</p>
          <p className="text-lg font-bold text-foreground">{filtered.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <TrendingUp className="h-3 w-3 text-emerald-500" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">{`Cr\u00e9ditos`}</p>
          </div>
          <p className="text-lg font-bold text-emerald-500">{formatCurrency(totalCredito)}</p>
          <p className="text-[10px] text-muted-foreground">{filtered.filter((i: any) => i.tipo === "CREDITO").length} {`transa\u00e7\u00f5es`}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <TrendingDown className="h-3 w-3 text-destructive" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">{`D\u00e9bitos`}</p>
          </div>
          <p className="text-lg font-bold text-destructive">{formatCurrency(totalDebito)}</p>
          <p className="text-[10px] text-muted-foreground">{filtered.filter((i: any) => i.tipo === "DEBITO").length} {`transa\u00e7\u00f5es`}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <ArrowLeftRight className="h-3 w-3 text-primary" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">{`Saldo L\u00edquido`}</p>
          </div>
          <p className={`text-lg font-bold ${totalCredito - totalDebito >= 0 ? "text-emerald-500" : "text-destructive"}`}>
            {formatCurrency(totalCredito - totalDebito)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <AlertTriangle className="h-3 w-3 text-amber-500" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">{`N\u00e3o Conciliado`}</p>
          </div>
          <p className="text-lg font-bold text-amber-500">{(excecoes || []).length}</p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(totalExcecoes)}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar nome, CPF/CNPJ, E2E ID, descri\u00e7\u00e3o, OS, G..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={tipoFilter} onValueChange={setTipoFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos tipos</SelectItem>
            <SelectItem value="CREDITO">{`Cr\u00e9dito`}</SelectItem>
            <SelectItem value="DEBITO">{`D\u00e9bito`}</SelectItem>
          </SelectContent>
        </Select>
        {tab === "conciliados" && (
          <Select value={vinculoFilter} onValueChange={setVinculoFilter}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">{`Todos v\u00ednculos`}</SelectItem>
              <SelectItem value="lancamento">{`Lan\u00e7amento`}</SelectItem>
              <SelectItem value="grupo_receber">Grupo Receber</SelectItem>
              <SelectItem value="grupo_pagar">Grupo Pagar</SelectItem>
              <SelectItem value="agenda">Agenda</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="conciliados">Conciliados ({filtered.length})</TabsTrigger>
          <TabsTrigger value="excecoes">{`N\u00e3o Conciliado`} ({filteredExc.length})</TabsTrigger>
          <TabsTrigger value="financeiro_nao_conciliado">{`Financeiro N\u00e3o Conciliado`} ({filteredFinNaoConc.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="conciliados" className="space-y-3">
          {isLoading ? (
            <p className="text-muted-foreground p-4">Carregando...</p>
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground p-4 text-center">{`Nenhum registro conciliado encontrado.`}</p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border bg-card overflow-hidden">
              {/* Header */}
              <div className="grid grid-cols-12 items-center gap-2 p-3 bg-muted/50 text-[10px] uppercase font-semibold text-muted-foreground">
                <div className="col-span-2">Data</div>
                <div className="col-span-2">Contraparte</div>
                <div className="col-span-1">CPF/CNPJ</div>
                <div className="col-span-2">{`Tipo / V\u00ednculo`}</div>
                <div className="col-span-1 text-right">Valor</div>
                <div className="col-span-2">GC / Dif.</div>
                <div className="col-span-2 text-right">{`A\u00e7\u00f5es`}</div>
              </div>
              {filtered.map((item: any) => renderRow(item))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{filtered.length} registro(s) conciliado(s)</p>
        </TabsContent>

        <TabsContent value="excecoes" className="space-y-3">
          {isLoadingExc ? (
            <p className="text-muted-foreground p-4">Carregando...</p>
          ) : filteredExc.length === 0 ? (
            <p className="text-muted-foreground p-4 text-center">{`Nenhuma exce\u00e7\u00e3o encontrada.`}</p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border bg-card overflow-hidden">
              <div className="grid grid-cols-12 items-center gap-2 p-3 bg-muted/50 text-[10px] uppercase font-semibold text-muted-foreground">
                <div className="col-span-2">Data</div>
                <div className="col-span-2">Contraparte</div>
                <div className="col-span-1">CPF/CNPJ</div>
                <div className="col-span-2">Motivo</div>
                <div className="col-span-1 text-right">Valor</div>
                <div className="col-span-2">{`Descri\u00e7\u00e3o`}</div>
                <div className="col-span-2 text-right">{`A\u00e7\u00f5es`}</div>
              </div>
              {filteredExc.map((item: any) => renderExcRow(item))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{filteredExc.length} registro(s) {`n\u00e3o conciliado(s)`}</p>
        </TabsContent>

        <TabsContent value="financeiro_nao_conciliado" className="space-y-3">
          {isLoadingFinNaoConc ? (
            <p className="text-muted-foreground p-4">Carregando...</p>
          ) : filteredFinNaoConc.length === 0 ? (
            <p className="text-muted-foreground p-4 text-center">{`Nenhum registro pendente.`}</p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border bg-card overflow-hidden">
              <div className="grid grid-cols-12 items-center gap-2 p-3 bg-muted/50 text-[10px] uppercase font-semibold text-muted-foreground">
                <div className="col-span-2">Data</div>
                <div className="col-span-2">Contraparte</div>
                <div className="col-span-1">CPF/CNPJ</div>
                <div className="col-span-2">Tipo</div>
                <div className="col-span-1 text-right">Valor</div>
                <div className="col-span-2">{`Descri\u00e7\u00e3o`}</div>
                <div className="col-span-2 text-right">{`A\u00e7\u00f5es`}</div>
              </div>
              {filteredFinNaoConc.map((item: any) => (
                <div key={item.id} className="grid grid-cols-12 items-center gap-2 p-3 hover:bg-muted/30 transition-colors">
                  <div className="col-span-2 text-xs text-muted-foreground">{formatDateTime(item.data_hora)}</div>
                  <div className="col-span-2 font-medium text-foreground truncate">{item.nome_contraparte || "\u2014"}</div>
                  <div className="col-span-1 text-xs text-muted-foreground font-mono truncate">{item.cpf_cnpj || "\u2014"}</div>
                  <div className="col-span-2">
                    <Badge variant="outline" className="text-[10px]">{item.tipo}</Badge>
                  </div>
                  <div className="col-span-1 text-right font-bold text-foreground">{formatCurrency(Math.abs(Number(item.valor_extrato || 0)))}</div>
                  <div className="col-span-2 text-xs text-muted-foreground truncate" title={item.descricao}>{item.descricao || "\u2014"}</div>
                  <div className="col-span-2 flex items-center justify-end">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setDetail(item)}>
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{filteredFinNaoConc.length} registro(s) pendente(s)</p>
        </TabsContent>
      </Tabs>

      {/* Detail Modal */}
      <Dialog open={!!detail} onOpenChange={() => setDetail(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{`Detalhes da Transa\u00e7\u00e3o`}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-3 gap-2">
                <span className="text-muted-foreground">Contraparte</span>
                <span className="col-span-2 font-medium">{detail.nome_contraparte || "\u2014"}</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <span className="text-muted-foreground">CPF/CNPJ</span>
                <span className="col-span-2 font-mono">{detail.cpf_cnpj || "\u2014"}</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <span className="text-muted-foreground">Tipo</span>
                <span className="col-span-2"><Badge variant="outline">{detail.tipo}</Badge></span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <span className="text-muted-foreground">Valor Extrato</span>
                <span className="col-span-2 font-bold">{formatCurrency(Math.abs(Number(detail.valor_extrato || 0)))}</span>
              </div>
              {detail.valor_gc != null && (
                <div className="grid grid-cols-3 gap-2">
                  <span className="text-muted-foreground">Valor GC</span>
                  <span className="col-span-2">{formatCurrency(Number(detail.valor_gc))}</span>
                </div>
              )}
              {detail.diferenca != null && detail.diferenca !== 0 && (
                <div className="grid grid-cols-3 gap-2">
                  <span className="text-muted-foreground">{`Diferen\u00e7a`}</span>
                  <span className="col-span-2">{diferencaBadge(detail)}</span>
                </div>
              )}
              {detail.qtd_parcelas != null && detail.qtd_parcelas > 1 && (
                <div className="grid grid-cols-3 gap-2">
                  <span className="text-muted-foreground">Parcelas</span>
                  <span className="col-span-2">{detail.qtd_parcelas}</span>
                </div>
              )}
              <div className="grid grid-cols-3 gap-2">
                <span className="text-muted-foreground">{`Descri\u00e7\u00e3o`}</span>
                <span className="col-span-2">{detail.descricao || "\u2014"}</span>
              </div>
              {detail.end_to_end_id && (
                <div className="grid grid-cols-3 gap-2">
                  <span className="text-muted-foreground">E2E ID</span>
                  <span className="col-span-2 font-mono text-xs break-all">{detail.end_to_end_id}</span>
                </div>
              )}
              {detail.chave_pix && (
                <div className="grid grid-cols-3 gap-2">
                  <span className="text-muted-foreground">Chave PIX</span>
                  <span className="col-span-2 font-mono text-xs break-all">{detail.chave_pix}</span>
                </div>
              )}
              {detail.reconciliation_rule && (
                <div className="grid grid-cols-3 gap-2">
                  <span className="text-muted-foreground">Regra</span>
                  <span className="col-span-2">
                    <Badge variant="secondary">{ruleLabels[detail.reconciliation_rule] || detail.reconciliation_rule}</Badge>
                  </span>
                </div>
              )}
              <div className="grid grid-cols-3 gap-2">
                <span className="text-muted-foreground">Data</span>
                <span className="col-span-2">{formatDateTime(detail.data_hora)}</span>
              </div>
              {detail.reconciliado_em && (
                <div className="grid grid-cols-3 gap-2">
                  <span className="text-muted-foreground">Conciliado em</span>
                  <span className="col-span-2">{formatDateTime(detail.reconciliado_em)}</span>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
