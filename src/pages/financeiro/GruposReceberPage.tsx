import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmarBaixaModal } from "@/components/financeiro/ConfirmarBaixaModal";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import { baixarGrupoReceberNoGC, gerarCobrancaPix, verificarCobrancaPix, resyncRecebimentoFromGC, gcDelay } from "@/api/financeiro";
import { Layers, Zap, Loader2, QrCode, Copy, CheckCircle, Eye, ExternalLink, FileText, Link2, Plus, Upload, AlertTriangle, ShieldCheck, RefreshCw } from "lucide-react";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";

export default function GruposReceberPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("todos");
  const [selectedGrupo, setSelectedGrupo] = useState<any>(null);
  const [showBaixa, setShowBaixa] = useState(false);
  const [baixaGrupoId, setBaixaGrupoId] = useState<string>("");
  const [generatingPix, setGeneratingPix] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [showNfse, setShowNfse] = useState(false);
  const [xmlFile, setXmlFile] = useState<File | null>(null);
  const [nfData, setNfData] = useState<any>(null);
  const [nfValidacao, setNfValidacao] = useState<any>(null);
  const [parsingXml, setParsingXml] = useState(false);
  const [savingNfse, setSavingNfse] = useState(false);
  const [resyncingGrupo, setResyncingGrupo] = useState(false);
  const { data: grupos, isLoading } = useQuery({
    queryKey: ["fin-grupos-receber", statusFilter],
    queryFn: async () => {
      let q = supabase.from("fin_grupos_receber").select("*").order("created_at", { ascending: false });
      if (statusFilter !== "todos") q = q.eq("status", statusFilter as any);
      const { data } = await q;
      return data || [];
    },
  });

  const { data: grupoItens } = useQuery({
    queryKey: ["fin-grupo-receber-itens", selectedGrupo?.id],
    enabled: !!selectedGrupo,
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_grupo_receber_itens")
        .select("*, fin_recebimentos(gc_id, gc_codigo, descricao, valor, os_codigo, pago_sistema, gc_baixado)")
        .eq("grupo_id", selectedGrupo.id);
      return data || [];
    },
  });

  const statusBadge = (s: string) => {
    const map: Record<string, string> = { 
      aberto: "bg-muted/50 text-muted-foreground", 
      aguardando_pagamento: "bg-amber-500/10 text-amber-500 border-amber-500/30 animate-pulse", 
      pago: "bg-emerald-500/10 text-emerald-500 border-emerald-500/30", 
      pago_parcial: "bg-orange-500/10 text-orange-500 border-orange-500/30", 
      cancelado: "bg-muted/50 text-muted-foreground" 
    };
    return <Badge variant="outline" className={`${map[s] || ""} text-[10px]`}>{s.replace("_", " ")}</Badge>;
  };

  const handleGerarPix = async (grupoId: string) => {
    setGeneratingPix(grupoId);
    try {
      const r = await gerarCobrancaPix(grupoId);
      toast.success(`PIX gerado: ${r.txid}`);
      queryClient.invalidateQueries({ queryKey: ["fin-grupos-receber"] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setGeneratingPix(null); }
  };

  const handleVerificar = async () => {
    if (!selectedGrupo?.inter_txid) return;
    setVerifying(true);
    try {
      const r = await verificarCobrancaPix(selectedGrupo.inter_txid);
      if (r.pago) {
        toast.success(`Pago por ${r.pagadorNome} em ${r.horario}`);
        queryClient.invalidateQueries({ queryKey: ["fin-grupos-receber"] });
      } else toast.success(`Status: ${r.status}`);
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setVerifying(false); }
  };

  const handleXmlUpload = async (file: File) => {
    if (!selectedGrupo) return;
    setXmlFile(file);
    setNfData(null);
    setNfValidacao(null);
    setParsingXml(true);
    try {
      const xmlContent = await file.text();
      const { data, error } = await supabase.functions.invoke("parse-nf-xml", {
        body: { xml_content: xmlContent, grupo_id: selectedGrupo.id },
      });
      if (error) throw new Error(error.message || "Erro ao processar XML");
      if (data?.error) throw new Error(data.error);
      setNfData(data.nf);
      setNfValidacao(data.validacao);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao processar XML");
      setXmlFile(null);
    } finally {
      setParsingXml(false);
    }
  };

  const handleSalvarNfse = async () => {
    if (!selectedGrupo || !nfData || !nfValidacao?.valido) return;
    setSavingNfse(true);
    try {
      // Upload XML to storage
      const filePath = `grupo-${selectedGrupo.id}/${Date.now()}-${xmlFile?.name || "nf.xml"}`;
      if (xmlFile) {
        const { error: upErr } = await supabase.storage.from("nf-xmls").upload(filePath, xmlFile, { contentType: "text/xml" });
        if (upErr) console.error("Erro upload XML:", upErr.message);
      }

      const { error } = await supabase.from("fin_grupos_receber").update({
        nfse_numero: nfData.numero || null,
        nfse_link: filePath, // reference to stored XML
        nfse_emitida_em: nfData.data_emissao || new Date().toISOString(),
        nfse_status: "validada",
      }).eq("id", selectedGrupo.id);
      if (error) throw error;

      toast.success("NF vinculada e validada com sucesso");
      setShowNfse(false);
      setSelectedGrupo({ ...selectedGrupo, nfse_numero: nfData.numero, nfse_link: filePath, nfse_emitida_em: nfData.data_emissao || new Date().toISOString(), nfse_status: "validada" });
      queryClient.invalidateQueries({ queryKey: ["fin-grupos-receber"] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro ao salvar NF"); }
    finally { setSavingNfse(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Grupos a Receber</h1>
          <p className="text-sm text-muted-foreground">Grupos de recebimentos para cobrança</p>
        </div>
        <div className="flex items-center gap-3">
          <SearchableSelect
            value={statusFilter}
            onValueChange={v => setStatusFilter(v || "todos")}
            options={[
              { value: "todos", label: "Todos" },
              { value: "aberto", label: "Aberto" },
              { value: "aguardando_pagamento", label: "Aguardando" },
              { value: "pago", label: "Pago" },
              { value: "pago_parcial", label: "Parcial" },
              { value: "cancelado", label: "Cancelado" },
            ]}
            placeholder="Filtrar status"
            searchPlaceholder="Buscar status..."
            className="w-[180px] h-9"
          />
          <Button size="sm" onClick={() => navigate("/financeiro/recebimentos")}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Criar Grupo
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Nome</th>
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Cliente</th>
              <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Valor</th>
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Vencimento</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">NFS-e</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Itens</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Status</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Baixa GC</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Ações</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={9} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></td></tr>
            ) : !grupos?.length ? (
              <tr><td colSpan={9}><EmptyState icon={Layers} title="Nenhum grupo" description="Crie grupos na tela de recebimentos." /></td></tr>
            ) : grupos.map((g: any) => (
              <tr key={g.id} className="border-b border-border hover:bg-muted/30">
                <td className="p-3 font-medium text-foreground">{g.nome}</td>
                <td className="p-3 text-foreground">{g.nome_cliente || "—"}</td>
                <td className="p-3 text-right font-semibold">{formatCurrency(Number(g.valor_total))}</td>
                <td className="p-3">{g.data_vencimento ? formatDate(g.data_vencimento) : "—"}</td>
                <td className="p-3 text-center text-xs">
                  {g.nfse_numero ? (
                    g.nfse_link ? (
                      <a href={g.nfse_link} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline flex items-center gap-1 justify-center">
                        <FileText className="h-3 w-3" />{g.nfse_numero}
                      </a>
                    ) : (
                      <span className="flex items-center gap-1 justify-center text-foreground"><FileText className="h-3 w-3" />{g.nfse_numero}</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="p-3 text-center text-xs">{g.itens_baixados ?? 0}/{g.itens_total ?? 0}</td>
                <td className="p-3 text-center">{statusBadge(g.status)}</td>
                <td className="p-3 text-center">
                  {g.gc_baixado ? (
                    <span className="text-emerald-500 text-[10px]">✅ {g.gc_baixado_em ? formatDate(g.gc_baixado_em) : ""}</span>
                  ) : g.inter_pago_em && !g.gc_baixado ? (
                    <Button size="sm" variant="outline" className="text-orange-500 border-orange-500/30 text-[10px] h-7" onClick={() => { setBaixaGrupoId(g.id); setShowBaixa(true); }}>
                      <Zap className="h-3 w-3 mr-1" />Baixar GC
                    </Button>
                  ) : (
                    <span className="text-muted-foreground text-[10px]">—</span>
                  )}
                </td>
                <td className="p-3 text-center">
                  <div className="flex items-center gap-1 justify-center">
                    <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setSelectedGrupo(g)}>
                      <Eye className="h-3 w-3" />
                    </Button>
                    {(g.status === "aberto" || g.status === "aguardando_pagamento") && !g.inter_txid && (
                      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => handleGerarPix(g.id)} disabled={generatingPix === g.id}>
                        {generatingPix === g.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <QrCode className="h-3 w-3" />}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Detail Sheet */}
      <Sheet open={!!selectedGrupo} onOpenChange={o => !o && setSelectedGrupo(null)}>
        <SheetContent className="w-[500px] sm:w-[600px] overflow-y-auto">
          {selectedGrupo && (
            <>
              <SheetHeader><SheetTitle>{selectedGrupo.nome}</SheetTitle></SheetHeader>
              <div className="mt-6 space-y-6">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Cliente</span>
                    <p className="font-medium">{selectedGrupo.nome_cliente || "—"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Valor Total</span>
                    <p className="font-semibold">{formatCurrency(Number(selectedGrupo.valor_total))}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Status</span>
                    <p>{statusBadge(selectedGrupo.status)}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Vencimento</span>
                    <p>{selectedGrupo.data_vencimento ? formatDate(selectedGrupo.data_vencimento) : "—"}</p>
                  </div>
                </div>

                {/* NFS-e section */}
                <div className="rounded-lg border border-border p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold flex items-center gap-2">
                      <FileText className="h-4 w-4" /> NFS-e
                    </h4>
                    {!selectedGrupo.nfse_numero && (
                      <Button variant="outline" size="sm" onClick={() => { setXmlFile(null); setNfData(null); setNfValidacao(null); setShowNfse(true); }}>
                        <Upload className="h-3 w-3 mr-1.5" /> Vincular NF
                      </Button>
                    )}
                    {selectedGrupo.nfse_numero && (
                      <Button variant="ghost" size="sm" onClick={() => { setXmlFile(null); setNfData(null); setNfValidacao(null); setShowNfse(true); }}>
                        Reenviar XML
                      </Button>
                    )}
                  </div>
                  {selectedGrupo.nfse_numero ? (
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className="text-muted-foreground">Número</span>
                        <p className="font-semibold">{selectedGrupo.nfse_numero}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Emitida em</span>
                        <p>{selectedGrupo.nfse_emitida_em ? formatDateTime(selectedGrupo.nfse_emitida_em) : "—"}</p>
                      </div>
                      {selectedGrupo.nfse_link && (
                        <div className="col-span-2">
                          <a href={selectedGrupo.nfse_link} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline flex items-center gap-1 text-sm">
                            <Link2 className="h-3 w-3" /> Acessar NFS-e
                          </a>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">Nenhuma NFS-e vinculada a este grupo.</p>
                  )}
                </div>

                {/* PIX section */}
                {selectedGrupo.inter_txid && (
                  <div className="rounded-lg border border-border p-4 space-y-3">
                    <h4 className="text-sm font-semibold">PIX Cobrança</h4>
                    <p className="text-xs text-muted-foreground">TXID: {selectedGrupo.inter_txid}</p>
                    {selectedGrupo.inter_copia_cola && (
                      <div className="flex items-center gap-2">
                        <Input value={selectedGrupo.inter_copia_cola} readOnly className="text-xs" />
                        <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(selectedGrupo.inter_copia_cola); toast.success("Copiado!"); }}>
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                    {selectedGrupo.inter_pago_em && (
                      <div className="flex items-center gap-2 text-emerald-500 text-sm">
                        <CheckCircle className="h-4 w-4" />
                        Pago em {formatDateTime(selectedGrupo.inter_pago_em)} por {selectedGrupo.inter_pagador}
                      </div>
                    )}
                    <Button variant="outline" size="sm" onClick={handleVerificar} disabled={verifying}>
                      {verifying ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}Verificar no Inter
                    </Button>
                  </div>
                )}

                {/* Baixa GC section */}
                {selectedGrupo.inter_pago_em && !selectedGrupo.gc_baixado && (
                  <div className="rounded-lg bg-orange-500/10 border border-orange-500/30 p-4 space-y-3">
                    <div className="flex items-center gap-2 text-sm">
                      <Zap className="h-4 w-4 text-orange-500" />
                      Inter confirmou em {formatDateTime(selectedGrupo.inter_pago_em)}. Clique para baixar no GC.
                    </div>
                    <Button variant="destructive" onClick={() => { setBaixaGrupoId(selectedGrupo.id); setShowBaixa(true); }}>
                      Enviar Baixa para GC
                    </Button>
                  </div>
                )}
                {selectedGrupo.gc_baixado && (
                  <div className="flex items-center gap-2 text-emerald-500 text-sm">
                    <CheckCircle className="h-4 w-4" />
                    Baixa enviada em {selectedGrupo.gc_baixado_em ? formatDateTime(selectedGrupo.gc_baixado_em) : ""}
                  </div>
                )}

                {/* Items */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold">Itens ({grupoItens?.length || 0})</h4>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={resyncingGrupo || !grupoItens?.length}
                      onClick={async () => {
                        setResyncingGrupo(true);
                        try {
                          const itensComGcId = grupoItens?.filter((i: any) => i.fin_recebimentos?.gc_id) || [];
                          if (!itensComGcId.length) { toast.error("Nenhum item com gc_id"); return; }
                          let ok = 0, fail = 0;
                          for (const item of itensComGcId) {
                            const success = await resyncRecebimentoFromGC(item.fin_recebimentos.gc_id);
                            if (success) ok++; else fail++;
                            await gcDelay();
                          }
                          // Recalculate group total
                          const { data: updatedItens } = await supabase
                            .from("fin_grupo_receber_itens")
                            .select("valor")
                            .eq("grupo_id", selectedGrupo.id);
                          const novoTotal = (updatedItens || []).reduce((s: number, i: any) => s + Number(i.valor || 0), 0);
                          await supabase.from("fin_grupos_receber").update({ valor_total: novoTotal, updated_at: new Date().toISOString() }).eq("id", selectedGrupo.id);

                          toast.success(`Atualizado ${ok}/${itensComGcId.length} itens do GC`);
                          if (fail) toast.error(`${fail} item(ns) falharam`);
                          queryClient.invalidateQueries({ queryKey: ["fin-grupo-receber-itens"] });
                          queryClient.invalidateQueries({ queryKey: ["fin-grupos-receber"] });
                        } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
                        finally { setResyncingGrupo(false); }
                      }}
                    >
                      {resyncingGrupo ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                      Atualizar do GC
                    </Button>
                  </div>
                  <div className="rounded-md border border-border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="p-2 text-left">Cód GC</th>
                          <th className="p-2 text-left">
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="cursor-help border-b border-dotted border-muted-foreground">OS Original</span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>Referência original no momento do agrupamento</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </th>
                          <th className="p-2 text-left">Descrição</th>
                          <th className="p-2 text-right">Valor</th>
                          <th className="p-2 text-center">Pago</th>
                          <th className="p-2 text-center">Baixa GC</th>
                        </tr>
                      </thead>
                      <tbody>
                        {grupoItens?.map((i: any) => {
                          const rec = i.fin_recebimentos;
                          const osOriginal = i.os_codigo_original || rec?.os_codigo;
                          const gcOsId = i.gc_os_id || rec?.gc_id;
                          
                          return (
                            <tr key={i.id} className="border-t border-border">
                              <td className="p-2 font-mono">{rec?.gc_codigo || "—"}</td>
                              <td className="p-2">
                                {osOriginal ? (
                                  gcOsId ? (
                                    <TooltipProvider>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <a 
                                            href={`https://gestaoclick.com/ordens_servicos/${gcOsId}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-primary hover:underline flex items-center gap-1"
                                          >
                                            {osOriginal}
                                            <ExternalLink className="h-3 w-3" />
                                          </a>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          <p>Valor snapshot: {i.snapshot_valor ? formatCurrency(Number(i.snapshot_valor)) : "—"}</p>
                                          <p>Data snapshot: {i.snapshot_data ? formatDate(i.snapshot_data) : "—"}</p>
                                        </TooltipContent>
                                      </Tooltip>
                                    </TooltipProvider>
                                  ) : (
                                    <TooltipProvider>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span className="text-foreground">{osOriginal}</span>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          <p>Valor snapshot: {i.snapshot_valor ? formatCurrency(Number(i.snapshot_valor)) : "—"}</p>
                                          <p>Data snapshot: {i.snapshot_data ? formatDate(i.snapshot_data) : "—"}</p>
                                        </TooltipContent>
                                      </Tooltip>
                                    </TooltipProvider>
                                  )
                                ) : (
                                  "—"
                                )}
                              </td>
                              <td className="p-2 truncate max-w-[150px]">{rec?.descricao}</td>
                              <td className="p-2 text-right font-medium">{formatCurrency(Number(i.valor || rec?.valor))}</td>
                              <td className="p-2 text-center">{rec?.pago_sistema ? "✅" : "—"}</td>
                              <td className="p-2 text-center">{i.gc_baixado ? "✅" : "⏳"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmarBaixaModal 
        open={showBaixa} 
        onOpenChange={(o) => { if (!o) { setShowBaixa(false); queryClient.invalidateQueries({ queryKey: ["fin-grupos-receber"] }); } }}
        titulo="Baixa do Grupo no GestãoClick" 
        tipoLancamento="recebimento"
        itens={grupoItens?.map((i: any) => ({ 
          id: i.id, 
          descricao: i.fin_recebimentos?.descricao || "", 
          valor: Number(i.valor || i.fin_recebimentos?.valor), 
          gc_id: i.fin_recebimentos?.gc_id || "", 
          gc_payload_raw: i.fin_recebimentos?.gc_payload_raw, 
          gc_baixado: i.gc_baixado 
        })) || []}
        onConfirmar={async (dataLiq) => { await baixarGrupoReceberNoGC(baixaGrupoId || selectedGrupo?.id, dataLiq); }} 
      />

      {/* NF XML Dialog */}
      <Dialog open={showNfse} onOpenChange={setShowNfse}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Vincular Nota Fiscal ao Grupo</DialogTitle>
          </DialogHeader>
          {selectedGrupo && (
            <div className="rounded-md bg-muted/50 border border-border p-3 text-xs space-y-1">
              <p><span className="text-muted-foreground">Grupo:</span> <span className="font-medium">{selectedGrupo.nome}</span></p>
              <p><span className="text-muted-foreground">Cliente:</span> <span className="font-medium">{selectedGrupo.nome_cliente || "—"}</span></p>
              <p><span className="text-muted-foreground">Valor:</span> <span className="font-semibold">{formatCurrency(Number(selectedGrupo.valor_total))}</span></p>
            </div>
          )}
          <div className="space-y-4">
            {/* Upload area */}
            <div className="space-y-2">
              <Label>XML da Nota Fiscal *</Label>
              <label className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border hover:border-primary/50 bg-muted/30 p-6 cursor-pointer transition-colors">
                <Upload className="h-6 w-6 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  {xmlFile ? xmlFile.name : "Clique para selecionar o XML"}
                </span>
                {parsingXml && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                <input
                  type="file"
                  accept=".xml,text/xml,application/xml"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleXmlUpload(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>

            {/* Parsed NF data */}
            {nfData && (
              <div className="rounded-lg border border-border p-3 space-y-2 text-xs">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <FileText className="h-4 w-4" />
                  {nfData.tipo === "nfse" ? "NFS-e" : nfData.tipo === "nfe" ? "NF-e" : "NF"} nº {nfData.numero || "—"}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-muted-foreground">Destinatário</span>
                    <p className="font-medium">{nfData.dest_razao || "—"}</p>
                    <p className="text-muted-foreground">{nfData.dest_cnpj || nfData.dest_cpf || "—"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Emitente</span>
                    <p className="font-medium">{nfData.emit_razao || "—"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Valor Total</span>
                    <p className="font-semibold">{formatCurrency(nfData.valor_total)}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Valor Líquido</span>
                    <p className="font-semibold">{formatCurrency(nfData.valor_liquido)}</p>
                  </div>
                  {nfData.valor_deducoes > 0 && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Retenções</span>
                      <p className="text-destructive font-medium">
                        - {formatCurrency(nfData.valor_deducoes)}
                        {nfData.valor_ir > 0 && ` (IR: ${formatCurrency(nfData.valor_ir)})`}
                        {nfData.valor_iss > 0 && ` (ISS: ${formatCurrency(nfData.valor_iss)})`}
                        {nfData.valor_pis > 0 && ` (PIS: ${formatCurrency(nfData.valor_pis)})`}
                        {nfData.valor_cofins > 0 && ` (COFINS: ${formatCurrency(nfData.valor_cofins)})`}
                        {nfData.valor_csll > 0 && ` (CSLL: ${formatCurrency(nfData.valor_csll)})`}
                        {nfData.valor_inss > 0 && ` (INSS: ${formatCurrency(nfData.valor_inss)})`}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Validation result */}
            {nfValidacao && (
              <>
                {nfValidacao.erros?.length > 0 && (
                  <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 space-y-1">
                    {nfValidacao.erros.map((err: string, i: number) => (
                      <p key={i} className="text-xs text-destructive flex items-start gap-1.5">
                        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {err}
                      </p>
                    ))}
                  </div>
                )}
                {nfValidacao.avisos?.length > 0 && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 space-y-1">
                    {nfValidacao.avisos.map((a: string, i: number) => (
                      <p key={i} className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {a}
                      </p>
                    ))}
                  </div>
                )}
                {nfValidacao.valido && (
                  <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-500" />
                    <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">Validação OK — cliente e valores conferem</span>
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNfse(false)}>Cancelar</Button>
            <Button onClick={handleSalvarNfse} disabled={savingNfse || !nfValidacao?.valido}>
              {savingNfse ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-1" />}
              Vincular NF
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
