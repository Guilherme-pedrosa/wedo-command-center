import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { CheckCircle, Search, Eye, ArrowLeftRight, TrendingUp, TrendingDown, AlertTriangle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

const GC_BASE = "https://app.gestaoclick.com.br";
const gcRecebimentoLink = (gcId: string) => `${GC_BASE}/recebimentos/${gcId}`;
const gcPagamentoLink = (gcId: string) => `${GC_BASE}/pagamentos/${gcId}`;
const gcOsLink = (osId: string) => `${GC_BASE}/ordens_servicos/${osId}`;

const EXCECAO_RULES = ["SEM_PAR_GC", "TRANSFERENCIA_INTERNA", "PIX_DEVOLVIDO_MANUAL"];

const ruleLabels: Record<string, string> = {
  SEM_PAR_GC: "Sem Par GC",
  TRANSFERENCIA_INTERNA: "Transferência Interna",
  PIX_DEVOLVIDO_MANUAL: "PIX Devolvido",
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

  // NÃO CONCILIADO
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

  // FINANCEIRO NÃO CONCILIADO
  const { data: financeirosNaoConciliados, isLoading: isLoadingFinNaoConc } = useQuery({
    queryKey: ["conciliacao-financeiro-nao-conciliado"],
    queryFn: async () => {
      const { data } = await supabase
        .from("vw_conciliacao_extrato" as any)
        .select("*")
        .eq("reconciliado", false)
        .is("reconciliation_rule", null)
        .order("data_extrato", { ascending: false })
        .limit(200);
      return (data as any[]) || [];
    },
  });

  const filtered = (items || [])
    .filter((i: any) => tipoFilter === "todos" || i.tipo === tipoFilter)
    .filter((i: any) => vinculoFilter === "todos" || i[vinculoFilter] === true)
    .filter((i: any) => {
      const searchTerm = search.toLowerCase();
      return (
        i.nome_cliente?.toLowerCase().includes(searchTerm) ||
        i.documento_cliente?.toLowerCase().includes(searchTerm) ||
        i.end_to_end_id?.toLowerCase().includes(searchTerm) ||
        i.descricao?.toLowerCase().includes(searchTerm) ||
        i.os_codigo?.toLowerCase().includes(searchTerm) ||
        i.gc_codigo?.toLowerCase().includes(searchTerm)
      );
    });

  const filteredExc = (excecoes || []).filter((i: any) => {
    const searchTerm = search.toLowerCase();
    return (
      i.nome_cliente?.toLowerCase().includes(searchTerm) ||
      i.documento_cliente?.toLowerCase().includes(searchTerm) ||
      i.end_to_end_id?.toLowerCase().includes(searchTerm) ||
      i.descricao?.toLowerCase().includes(searchTerm) ||
      i.os_codigo?.toLowerCase().includes(searchTerm) ||
      i.gc_codigo?.toLowerCase().includes(searchTerm)
    );
  });

  const filteredFinNaoConc = (financeirosNaoConciliados || []).filter((i: any) => {
    const searchTerm = search.toLowerCase();
    return (
      i.nome_cliente?.toLowerCase().includes(searchTerm) ||
      i.documento_cliente?.toLowerCase().includes(searchTerm) ||
      i.end_to_end_id?.toLowerCase().includes(searchTerm) ||
      i.descricao?.toLowerCase().includes(searchTerm) ||
      i.os_codigo?.toLowerCase().includes(searchTerm) ||
      i.gc_codigo?.toLowerCase().includes(searchTerm)
    );
  });

  // Stats
  const totalCredito = filtered.filter((i: any) => i.tipo === "CREDITO").reduce((s: number, i: any) => s + Math.abs(Number(i.valor_extrato ?? i.valor)), 0);
  const totalDebito = filtered.filter((i: any) => i.tipo === "DEBITO").reduce((s: number, i: any) => s + Math.abs(Number(i.valor_extrato ?? i.valor)), 0);
  const totalExcecoes = (excecoes || []).reduce((s: number, i: any) => s + Math.abs(Number(i.valor_extrato ?? i.valor)), 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{"Histórico de Conciliação"}</h1>
        <p className="text-sm text-muted-foreground">{"Registro detalhado de todas as transações reconciliadas"}</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="text-[10px] uppercase text-muted-foreground font-semibold">Total Conciliado</p>
          <p className="text-lg font-bold text-foreground">{filtered.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <TrendingUp className="h-3 w-3 text-wedo-green" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">{"Créditos"}</p>
          </div>
          <p className="text-lg font-bold text-wedo-green">{formatCurrency(totalCredito)}</p>
          <p className="text-[10px] text-muted-foreground">{filtered.filter((i: any) => i.tipo === "CREDITO").length} {"transações"}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <TrendingDown className="h-3 w-3 text-wedo-red" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">{"Débitos"}</p>
          </div>
          <p className="text-lg font-bold text-wedo-red">{formatCurrency(totalDebito)}</p>
          <p className="text-[10px] text-muted-foreground">{filtered.filter((i: any) => i.tipo === "DEBITO").length} {"transações"}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <ArrowLeftRight className="h-3 w-3 text-primary" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">{"Saldo Líquido"}</p>
          </div>
          <p className={`text-lg font-bold ${totalCredito - totalDebito >= 0 ? "text-wedo-green" : "text-wedo-red"}`}>
            {formatCurrency(totalCredito - totalDebito)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <AlertTriangle className="h-3 w-3 text-wedo-orange" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">{"Não Conciliado"}</p>
          </div>
          <p className="text-lg font-bold text-wedo-orange">{(excecoes || []).length}</p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(totalExcecoes)}</p>
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
            <SelectItem value="CREDITO">{"Crédito"}</SelectItem>
            <SelectItem value="DEBITO">{"Débito"}</SelectItem>
          </SelectContent>
        </Select>
        {tab === "conciliados" && (
          <Select value={vinculoFilter} onValueChange={setVinculoFilter}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">{"Todos vínculos"}</SelectItem>
              <SelectItem value="lancamento">{"Lançamento"}</SelectItem>
              <SelectItem value="grupo_receber">Grupo Receber</SelectItem>
              <SelectItem value="grupo_pagar">Grupo Pagar</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="conciliados">Conciliados ({filtered.length})</TabsTrigger>
          <TabsTrigger value="excecoes">{"Não Conciliado"} ({filteredExc.length})</TabsTrigger>
          <TabsTrigger value="financeiro_nao_conciliado">Financeiro Não Conciliado ({filteredFinNaoConc.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="conciliados" className="space-y-3">
          {isLoading ? (
            <p>Carregando...</p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border">
              {filtered.map((item: any) => (
                <div key={item.id} className="grid grid-cols-12 items-center gap-2 p-3">
                  <div className="col-span-2 text-xs text-muted-foreground">{formatDateTime(item.reconciliado_em)}</div>
                  <div className="col-span-2 font-medium">{item.nome_cliente}</div>
                  <div className="col-span-1 text-xs text-muted-foreground">{item.documento_cliente}</div>
                  <div className="col-span-2">
                    <Badge variant="outline">{item.tipo}</Badge>
                    {item.lancamento && (
                      <Tooltip>
                        <TooltipTrigger><Badge className="ml-1" variant="secondary">Lançamento</Badge></TooltipTrigger>
                        <TooltipContent>Conciliado automaticamente com um lançamento</TooltipContent>
                      </Tooltip>
                    )}
                    {item.grupo_receber && (
                      <Tooltip>
                        <TooltipTrigger><Badge className="ml-1" variant="secondary">Grupo Receber</Badge></TooltipTrigger>
                        <TooltipContent>Conciliado automaticamente com um grupo de recebimento</TooltipContent>
                      </Tooltip>
                    )}
                    {item.grupo_pagar && (
                      <Tooltip>
                        <TooltipTrigger><Badge className="ml-1" variant="secondary">Grupo Pagar</Badge></TooltipTrigger>
                        <TooltipContent>Conciliado automaticamente com um grupo de pagamento</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  <div className="col-span-2 font-bold">{formatCurrency(item.valor_extrato ?? item.valor)}</div>
                  <div className="col-span-3 flex items-center justify-end gap-2">
                    {item.gc_codigo && (
                      <Tooltip>
                        <TooltipTrigger>
                          <Button size="icon" variant="ghost" asChild>
                            <a href={item.tipo === "CREDITO" ? gcRecebimentoLink(item.gc_codigo) : gcPagamentoLink(item.gc_codigo)} target="_blank" rel="noreferrer">
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Ver no GestãoClick</TooltipContent>
                      </Tooltip>
                    )}
                    {item.os_codigo && (
                      <Tooltip>
                        <TooltipTrigger>
                          <Button size="icon" variant="ghost" asChild>
                            <a href={gcOsLink(item.os_codigo)} target="_blank" rel="noreferrer">
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Ver OS no GestãoClick</TooltipContent>
                      </Tooltip>
                    )}
                    <Button size="icon" variant="ghost" onClick={() => setDetail(item)}>
                      <Eye className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="excecoes" className="space-y-3">
          {isLoadingExc ? (
            <p>Carregando...</p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border">
              {filteredExc.map((item: any) => (
                <div key={item.id} className="grid grid-cols-12 items-center gap-2 p-3">
                  <div className="col-span-2 text-xs text-muted-foreground">{formatDateTime(item.reconciliado_em)}</div>
                  <div className="col-span-2 font-medium">{item.nome_cliente}</div>
                  <div className="col-span-1 text-xs text-muted-foreground">{item.documento_cliente}</div>
                  <div className="col-span-2">
                    <Badge variant="destructive">{ruleLabels[item.reconciliation_rule]}</Badge>
                  </div>
                  <div className="col-span-2 font-bold">{formatCurrency(item.valor_extrato ?? item.valor)}</div>
                  <div className="col-span-3 flex items-center justify-end gap-2">
                    {item.gc_codigo && (
                      <Tooltip>
                        <TooltipTrigger>
                          <Button size="icon" variant="ghost" asChild>
                            <a href={item.tipo === "CREDITO" ? gcRecebimentoLink(item.gc_codigo) : gcPagamentoLink(item.gc_codigo)} target="_blank" rel="noreferrer">
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Ver no GestãoClick</TooltipContent>
                      </Tooltip>
                    )}
                    {item.os_codigo && (
                      <Tooltip>
                        <TooltipTrigger>
                          <Button size="icon" variant="ghost" asChild>
                            <a href={gcOsLink(item.os_codigo)} target="_blank" rel="noreferrer">
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Ver OS no GestãoClick</TooltipContent>
                      </Tooltip>
                    )}
                    <Button size="icon" variant="ghost" onClick={() => setDetail(item)}>
                      <Eye className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="financeiro_nao_conciliado" className="space-y-3">
          {isLoadingFinNaoConc ? (
            <p>Carregando...</p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border">
              {filteredFinNaoConc.map((item: any) => (
                <div key={item.id} className="grid grid-cols-12 items-center gap-2 p-3">
                  <div className="col-span-2 text-xs text-muted-foreground">{formatDateTime(item.data_extrato)}</div>
                  <div className="col-span-2 font-medium">{item.nome_cliente}</div>
                  <div className="col-span-1 text-xs text-muted-foreground">{item.documento_cliente}</div>
                  <div className="col-span-2">
                    <Badge variant="secondary">{"Não Conciliado"}</Badge>
                  </div>
                  <div className="col-span-2 font-bold">{formatCurrency(item.valor_extrato ?? item.valor)}</div>
                  <div className="col-span-3 flex items-center justify-end gap-2">
                    {item.gc_codigo && (
                      <Tooltip>
                        <TooltipTrigger>
                          <Button size="icon" variant="ghost" asChild>
                            <a href={item.tipo === "CREDITO" ? gcRecebimentoLink(item.gc_codigo) : gcPagamentoLink(item.gc_codigo)} target="_blank" rel="noreferrer">
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Ver no GestãoClick</TooltipContent>
                      </Tooltip>
                    )}
                    {item.os_codigo && (
                      <Tooltip>
                        <TooltipTrigger>
                          <Button size="icon" variant="ghost" asChild>
                            <a href={gcOsLink(item.os_codigo)} target="_blank" rel="noreferrer">
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Ver OS no GestãoClick</TooltipContent>
                      </Tooltip>
                    )}
                    <Button size="icon" variant="ghost" onClick={() => setDetail(item)}>
                      <Eye className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Detail Modal */}
      <Dialog open={!!detail} onOpenChange={() => setDetail(null)}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Detalhes</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <label htmlFor="name" className="text-right text-sm font-medium leading-none text-muted-foreground">
                Nome
              </label>
              <div className="col-span-3 text-foreground">{detail?.nome_cliente}</div>
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <label htmlFor="username" className="text-right text-sm font-medium leading-none text-muted-foreground">
                Documento
              </label>
              <div className="col-span-3 text-foreground">{detail?.documento_cliente}</div>
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <label htmlFor="username" className="text-right text-sm font-medium leading-none text-muted-foreground">
                Tipo
              </label>
              <div className="col-span-3 text-foreground">{detail?.tipo}</div>
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <label htmlFor="username" className="text-right text-sm font-medium leading-none text-muted-foreground">
                Valor
              </label>
              <div className="col-span-3 text-foreground">{formatCurrency(detail?.valor_extrato ?? detail?.valor)}</div>
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <label htmlFor="username" className="text-right text-sm font-medium leading-none text-muted-foreground">
                Descrição
              </label>
              <div className="col-span-3 text-foreground">{detail?.descricao}</div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
