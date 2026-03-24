import { useState, useEffect } from "react";
import { addMonths, format as fnsFormat } from "date-fns";
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
import { baixarGrupoReceberNoGC, gerarCobrancaPix, verificarCobrancaPix, resyncRecebimentoFromGC, gcDelay, atualizarRecebimentoGC, registrarResidualNegociacao } from "@/api/financeiro";
import { Layers, Zap, Loader2, QrCode, Copy, CheckCircle, Eye, ExternalLink, FileText, Link2, Plus, Upload, AlertTriangle, ShieldCheck, RefreshCw, Pencil, Trash2, CalendarIcon, Search, X, Minus, Sparkles, ScanSearch, Banknote, Check } from "lucide-react";
import { SmartGroupDialog } from "@/components/financeiro/SmartGroupDialog";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";

export default function GruposReceberPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const GC_BASE = "https://gestaoclick.com";

  const roundMoney = (value: number) => Math.round(value * 100) / 100;

  const findClosestSubsetAtOrBelow = (
    items: Array<{ key: string; valor: number }>,
    target: number,
  ) => {
    const sorted = [...items]
      .filter((item) => item.valor > 0)
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 30);

    let bestKeys: string[] = [];
    let bestSum = 0;
    const tolerance = 0.02;

    const search = (index: number, currentSum: number, chosen: string[]) => {
      if (Math.abs(currentSum - target) <= tolerance) {
        bestKeys = [...chosen];
        bestSum = currentSum;
        return true;
      }

      if (currentSum > bestSum && currentSum <= target + tolerance) {
        bestSum = currentSum;
        bestKeys = [...chosen];
      }

      if (index >= sorted.length) return false;

      let remaining = 0;
      for (let i = index; i < sorted.length; i++) remaining += sorted[i].valor;
      if (currentSum + remaining < bestSum) return false;

      for (let i = index; i < sorted.length; i++) {
        const next = currentSum + sorted[i].valor;
        if (next <= target + tolerance) {
          chosen.push(sorted[i].key);
          if (search(i + 1, next, chosen)) return true;
          chosen.pop();
        }
      }

      return false;
    };

    search(0, 0, []);
    return new Set(bestKeys);
  };

  const handleDownloadXml = async (filePath: string) => {
    try {
      const { data, error } = await supabase.storage.from("nf-xmls").createSignedUrl(filePath, 300);
      if (error || !data?.signedUrl) throw new Error("Erro ao gerar link");
      window.open(data.signedUrl, "_blank");
    } catch (err) {
      toast.error("Erro ao abrir XML");
    }
  };

  const handleOpenNfseGC = async (nfseNumero: string) => {
    try {
      toast.loading("Buscando NFS-e no GestãoClick...", { id: "nfse-gc" });
      const { callGC } = await import("@/lib/gc-client");
      const res = await callGC<any>({
        endpoint: "/api/notas_fiscais_servicos",
        params: { numero: nfseNumero, limite: "1" },
      });
      const nfse = res.data?.data?.[0];
      if (!nfse?.id) {
        toast.error("NFS-e não encontrada no GestãoClick", { id: "nfse-gc" });
        return;
      }
      toast.dismiss("nfse-gc");
      window.open(`https://gestaoclick.com/notas_fiscais_servicos/visualizar/${nfse.id}`, "_blank");
    } catch (err) {
      toast.error("Erro ao buscar NFS-e no GC", { id: "nfse-gc" });
    }
  };

  const handleOpenGrupoRecebimentosGC = () => {
    if (!selectedGrupo) return;

    const negNum = selectedGrupo.negociacao_numero;
    const nfNum = selectedGrupo.nfse_numero;
    
    let searchTerm = '';
    if (negNum && nfNum) {
      searchTerm = `NEG ${negNum} NF${nfNum}`;
    } else if (negNum) {
      searchTerm = `NEG ${negNum}`;
    } else if (nfNum) {
      searchTerm = `NF ${nfNum}`;
    } else {
      searchTerm = selectedGrupo.nome || '';
    }

    if (!searchTerm) {
      toast.error("Esse grupo não tem informações suficientes para buscar no GC");
      return;
    }

    const vencimento = selectedGrupo.data_vencimento;
    let dataInicio = '01/01/2020';
    let dataFim = '31/12/2030';
    
    if (vencimento) {
      const d = new Date(vencimento + 'T12:00:00');
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      dataInicio = `${dd}/${mm}/${yyyy}`;
      dataFim = `${dd}/${mm}/${yyyy}`;
    }

    const params = new URLSearchParams({
      loja: '446246',
      'tipo-entidade': 'C',
      nome: searchTerm,
      data_inicio: dataInicio,
      data_fim: dataFim,
      tipo: 'C',
      situacaoBuscaAvancada: 'true',
    });

    window.open(
      `${GC_BASE}/movimentacoes_financeiras/index_recebimento?${params.toString()}`,
      "_blank",
      "noopener,noreferrer"
    );
  };

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
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editNome, setEditNome] = useState("");
  const [editVencimento, setEditVencimento] = useState("");
  const [editObs, setEditObs] = useState("");
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editItensToRemove, setEditItensToRemove] = useState<string[]>([]);
  const [editItensToAdd, setEditItensToAdd] = useState<any[]>([]);
  const [searchReceb, setSearchReceb] = useState("");
  const [searchingReceb, setSearchingReceb] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [syncingGC, setSyncingGC] = useState(false);
  const [showSmartGroup, setShowSmartGroup] = useState(false);
  const [scanningPassivos, setScanningPassivos] = useState(false);
  const [markingPassivo, setMarkingPassivo] = useState<string | null>(null);
  const [editValorCobrar, setEditValorCobrar] = useState<number | null>(null);
  const [editingItemValor, setEditingItemValor] = useState<string | null>(null);
  const [osIdMap, setOsIdMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!selectedGrupo?.os_codigos?.length) {
      setOsIdMap({});
      return;
    }
    const fetchOsIds = async () => {
      const { data } = await supabase
        .from("os_index")
        .select("os_id, os_codigo")
        .in("os_codigo", selectedGrupo.os_codigos as string[]);
      const map: Record<string, string> = {};
      for (const r of (data || []) as { os_id: string; os_codigo: string }[]) {
        if (!map[r.os_codigo]) map[r.os_codigo] = r.os_id;
      }
      setOsIdMap(map);
    };
    fetchOsIds();
  }, [selectedGrupo?.id]);

  const canEditGroup = (g: any) => !g.nfse_numero && !g.gc_baixado && g.status !== "pago";

  const handleEditGroup = async () => {
    if (!selectedGrupo) return;
    setSaving(true);
    try {
      const { data: currentGroupItems, error: currentItemsError } = await supabase
        .from("fin_grupo_receber_itens")
        .select("id, recebimento_id, valor, os_codigo_original, fin_recebimentos(valor, os_codigo, descricao)")
        .eq("grupo_id", selectedGrupo.id);

      if (currentItemsError) throw currentItemsError;

      const baseItems = (currentGroupItems || [])
        .filter((item: any) => !editItensToRemove.includes(item.id))
        .map((item: any) => ({
          key: `existing:${item.id}`,
          source: "existing" as const,
          groupItemId: item.id,
          recebimentoId: item.recebimento_id,
          valor: Number(item.valor || item.fin_recebimentos?.valor || 0),
          osCodigo: item.os_codigo_original || item.fin_recebimentos?.os_codigo || null,
        }));

      const addedItems = editItensToAdd.map((rec: any) => ({
        key: `new:${rec.id}`,
        source: "new" as const,
        recebimentoId: rec.id,
        valor: Number(rec.valor || 0),
        osCodigo: rec.os_codigo || null,
      }));

      const candidateItems = [...baseItems, ...addedItems].filter((item) => item.valor > 0);
      if (!candidateItems.length) {
        throw new Error("O grupo precisa ter pelo menos um item.");
      }

      const totalItens = roundMoney(candidateItems.reduce((sum, item) => sum + item.valor, 0));
      const valorDesejado = editValorCobrar !== null
        ? Math.max(0.01, roundMoney(editValorCobrar))
        : totalItens;

      // Se o valor desejado >= total dos itens (com tolerância), manter todos
      const keepKeys = valorDesejado < totalItens - 1.00
        ? findClosestSubsetAtOrBelow(candidateItems.map((item) => ({ key: item.key, valor: item.valor })), valorDesejado)
        : new Set(candidateItems.map((item) => item.key));

      const keptItems = candidateItems.filter((item) => keepKeys.has(item.key));
      const removedItems = candidateItems.filter((item) => !keepKeys.has(item.key));

      if (!keptItems.length) {
        throw new Error("Nenhuma combinação de itens fecha o valor informado. Ajuste o valor a cobrar.");
      }

      const removedExisting = removedItems.filter((item) => item.source === "existing");
      if (removedExisting.length > 0) {
        const recebimentoIds = removedExisting.map((item) => item.recebimentoId);
        const groupItemIds = removedExisting.map((item) => item.groupItemId).filter(Boolean);

        await supabase.from("fin_recebimentos").update({ grupo_id: null }).in("id", recebimentoIds);
        if (groupItemIds.length > 0) {
          await supabase.from("fin_grupo_receber_itens").delete().in("id", groupItemIds as string[]);
        }
      }

      const keptNewItems = keptItems.filter((item) => item.source === "new");
      if (keptNewItems.length > 0) {
        await supabase.from("fin_grupo_receber_itens").insert(
          keptNewItems.map((item) => {
            const rec = editItensToAdd.find((entry: any) => entry.id === item.recebimentoId);
            return {
              grupo_id: selectedGrupo.id,
              recebimento_id: item.recebimentoId,
              valor: item.valor,
              os_codigo_original: item.osCodigo,
              gc_os_id: rec?.gc_id || null,
              snapshot_valor: item.valor,
              snapshot_data: rec?.data_vencimento || null,
            };
          }),
        );
        await supabase.from("fin_recebimentos").update({ grupo_id: selectedGrupo.id }).in("id", keptNewItems.map((item) => item.recebimentoId));
      }

      const valorGrupoFinal = roundMoney(keptItems.reduce((sum, item) => sum + item.valor, 0));
      const valorSeparado = roundMoney(removedItems.reduce((sum, item) => sum + item.valor, 0));
      const osCodigos = Array.from(new Set(keptItems.map((item) => item.osCodigo).filter(Boolean)));
      const osCodigosSeparados = Array.from(new Set(removedItems.map((item) => item.osCodigo).filter(Boolean)));
      const keptRecebimentoIds = keptItems.map((item) => item.recebimentoId);

      const { error } = await supabase.from("fin_grupos_receber").update({
        nome: editNome,
        data_vencimento: editVencimento || null,
        observacao: editObs || null,
        valor_total: valorGrupoFinal,
        itens_total: keptItems.length,
        os_codigos: osCodigos.length > 0 ? osCodigos : null,
        updated_at: new Date().toISOString(),
      }).eq("id", selectedGrupo.id);
      if (error) throw error;

      if (valorSeparado > 0.01 && selectedGrupo.cliente_gc_id) {
        const { error: residualError } = await supabase.from("fin_residuos_negociacao").insert({
          cliente_gc_id: selectedGrupo.cliente_gc_id,
          nome_cliente: selectedGrupo.nome_cliente || "—",
          valor_residual: valorSeparado,
          negociacao_origem_numero: selectedGrupo.negociacao_numero || null,
          os_codigos: osCodigosSeparados.length > 0 ? osCodigosSeparados : null,
          observacao: `Passivo gerado na edição do grupo "${editNome}" — Valor cobrado: ${formatCurrency(valorGrupoFinal)} · Valor separado: ${formatCurrency(valorSeparado)}`,
          utilizado: false,
        });
        if (residualError) throw residualError;
      }

      if (editVencimento && keptRecebimentoIds.length > 0) {
        await supabase.from("fin_recebimentos").update({ data_vencimento: editVencimento }).in("id", keptRecebimentoIds);
        
        // Sync vencimento dos itens mantidos no GC
        for (const item of keptItems) {
          const rec = grupoItens?.find((gi: any) => gi.recebimento_id === item.recebimentoId)?.fin_recebimentos
            || editItensToAdd.find((r: any) => r.id === item.recebimentoId);
          if (rec?.gc_id && rec?.gc_payload_raw) {
            try {
              await atualizarRecebimentoGC(rec.gc_id, rec.gc_payload_raw as Record<string, unknown>, { data_vencimento: editVencimento });
            } catch { /* ignore */ }
            await gcDelay();
          }
        }
      }

      // Itens removidos do grupo: vencimento = 1 mês depois do grupo
      if (editVencimento && removedExisting.length > 0) {
        const vencPostergado = fnsFormat(addMonths(new Date(editVencimento + 'T12:00:00'), 1), "yyyy-MM-dd");
        const removedRecIds = removedExisting.map((item) => item.recebimentoId);
        await supabase.from("fin_recebimentos").update({ data_vencimento: vencPostergado }).in("id", removedRecIds);
        
        // Sync no GC
        for (const item of removedExisting) {
          const rec = grupoItens?.find((gi: any) => gi.recebimento_id === item.recebimentoId)?.fin_recebimentos;
          if (rec?.gc_id && rec?.gc_payload_raw) {
            try {
              await atualizarRecebimentoGC(rec.gc_id, rec.gc_payload_raw as Record<string, unknown>, { data_vencimento: vencPostergado });
            } catch { /* ignore */ }
            await gcDelay();
          }
        }
        toast.success(`${removedExisting.length} item(ns) removido(s) → venc. ${fnsFormat(addMonths(new Date(editVencimento + 'T12:00:00'), 1), "dd/MM/yyyy")}`);
      }

      toast.success(
        valorSeparado > 0.01
          ? `Grupo ajustado: ${formatCurrency(valorGrupoFinal)} no grupo e ${formatCurrency(valorSeparado)} em passivo`
          : "Grupo atualizado",
      );
      setShowEditDialog(false);
      setSelectedGrupo(null);
      queryClient.invalidateQueries({ queryKey: ["fin-grupos-receber"] });
      queryClient.invalidateQueries({ queryKey: ["fin-grupo-receber-itens"] });
      queryClient.invalidateQueries({ queryKey: ["fin-passivos-cliente"] });
      queryClient.invalidateQueries({ queryKey: ["fin-recebimentos"] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setSaving(false); }
  };

  const handleSearchRecebimentos = async (term: string) => {
    setSearchReceb(term);
    if (term.length < 2) { setSearchResults([]); return; }
    setSearchingReceb(true);
    try {
      let q = supabase.from("fin_recebimentos")
        .select("id, descricao, valor, os_codigo, gc_codigo, gc_id, data_vencimento, nome_cliente")
        .is("grupo_id", null)
        .order("data_vencimento", { ascending: false })
        .limit(20);
      
      // Search by OS code, description, or gc_codigo
      q = q.or(`os_codigo.ilike.%${term}%,descricao.ilike.%${term}%,gc_codigo.ilike.%${term}%`);
      
      const { data } = await q;
      // Filter out already-added items
      const addedIds = editItensToAdd.map(i => i.id);
      setSearchResults((data || []).filter(r => !addedIds.includes(r.id)));
    } catch { setSearchResults([]); }
    finally { setSearchingReceb(false); }
  };

  const handleDeleteGroup = async () => {
    if (!selectedGrupo) return;
    setDeleting(true);
    try {
      // Remove grupo_id from linked recebimentos
      const { data: itens } = await supabase
        .from("fin_grupo_receber_itens")
        .select("recebimento_id")
        .eq("grupo_id", selectedGrupo.id);
      if (itens?.length) {
        const ids = itens.map((i: any) => i.recebimento_id);
        await supabase.from("fin_recebimentos").update({ grupo_id: null }).in("id", ids);
      }
      // Delete items then group
      await supabase.from("fin_grupo_receber_itens").delete().eq("grupo_id", selectedGrupo.id);
      await supabase.from("fin_grupos_receber").delete().eq("id", selectedGrupo.id);

      toast.success("Grupo excluído");
      setShowDeleteConfirm(false);
      setSelectedGrupo(null);
      queryClient.invalidateQueries({ queryKey: ["fin-grupos-receber"] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setDeleting(false); }
  };
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
        .select("*, fin_recebimentos(gc_id, gc_codigo, descricao, valor, os_codigo, pago_sistema, gc_baixado, gc_payload_raw, nfe_numero)")
        .eq("grupo_id", selectedGrupo.id);
      return data || [];
    },
  });

  const grupoItensTotal = roundMoney(
    (grupoItens || []).reduce((sum: number, item: any) => sum + Number(item.valor || item.fin_recebimentos?.valor || 0), 0),
  );

  // Fetch passivos (residuos) for the selected group's client
  const { data: clientePassivos, refetch: refetchPassivos } = useQuery({
    queryKey: ["fin-passivos-cliente", selectedGrupo?.cliente_gc_id],
    enabled: !!selectedGrupo?.cliente_gc_id,
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_residuos_negociacao")
        .select("*")
        .eq("cliente_gc_id", selectedGrupo.cliente_gc_id)
        .eq("utilizado", false)
        .order("created_at", { ascending: false });
      return data || [];
    },
  });

  const handleScanPassivos = async () => {
    setScanningPassivos(true);
    try {
      const { data, error } = await supabase.functions.invoke("scan-passivos");
      if (error) throw error;
      toast.success(`Scan concluído: ${data.inserted} passivo(s) importado(s), ${data.skipped} já existente(s)`);
      refetchPassivos();
    } catch (err) {
      toast.error(`Erro: ${(err as Error).message}`);
    } finally {
      setScanningPassivos(false);
    }
  };

  const handleMarcarPassivoUtilizado = async (passivoId: string) => {
    setMarkingPassivo(passivoId);
    try {
      const { error } = await supabase
        .from("fin_residuos_negociacao")
        .update({ utilizado: true, utilizado_em: new Date().toISOString() })
        .eq("id", passivoId);
      if (error) throw error;
      toast.success("Passivo marcado como utilizado");
      refetchPassivos();
    } catch (err) {
      toast.error(`Erro: ${(err as Error).message}`);
    } finally {
      setMarkingPassivo(null);
    }
  };

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

      // Preencher nfe_numero em cada recebimento vinculado ao grupo
      if (nfData.numero) {
        await supabase.from("fin_recebimentos")
          .update({ nfe_numero: nfData.numero })
          .eq("grupo_id", selectedGrupo.id);
      }

      toast.success("NF vinculada e validada com sucesso");
      setShowNfse(false);
      setSelectedGrupo({ ...selectedGrupo, nfse_numero: nfData.numero, nfse_link: filePath, nfse_emitida_em: nfData.data_emissao || new Date().toISOString(), nfse_status: "validada" });
      queryClient.invalidateQueries({ queryKey: ["fin-grupos-receber"] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro ao salvar NF"); }
    finally { setSavingNfse(false); }
  };

  const handleSyncNfseGC = async () => {
    if (!selectedGrupo || !selectedGrupo.nfse_numero) return;
    setSyncingGC(true);
    let ok = 0;
    let erros = 0;
    try {
      // 1. Update recebimentos in GC
      if (grupoItens?.length) {
        for (const item of grupoItens) {
          const rec = item.fin_recebimentos as any;
          if (!rec?.gc_id || !rec?.gc_payload_raw) { erros++; continue; }

          const descOriginal = rec.descricao || "";
          const nfTag = `NF ${selectedGrupo.nfse_numero}`;
          const novaDescricao = descOriginal.includes(nfTag) ? descOriginal : `${descOriginal} — ${nfTag}`;
          
          try {
            await atualizarRecebimentoGC(rec.gc_id, rec.gc_payload_raw, {
              descricao: novaDescricao,
              observacao: `NFS-e ${selectedGrupo.nfse_numero} vinculada via ARGUS`,
              data_vencimento: selectedGrupo.data_vencimento || undefined,
              nf_numero: selectedGrupo.nfse_numero,
              atributos: [{ atributo_id: 8928, valor: selectedGrupo.nfse_numero }],
            });
            await gcDelay();

            await supabase.from("fin_recebimentos")
              .update({ 
                descricao: novaDescricao, 
                nfe_numero: selectedGrupo.nfse_numero,
                data_vencimento: selectedGrupo.data_vencimento || undefined,
              })
              .eq("id", item.recebimento_id);
            ok++;
          } catch (e) {
            console.error(`Erro sync GC item ${rec.gc_codigo}:`, e);
            erros++;
          }
        }
      }

      // 2. Update OS in GC with NF number
      const osCodigos = selectedGrupo.os_codigos as string[] | null;
      if (osCodigos?.length) {
        const { callGC } = await import("@/lib/gc-client");
        
        // Look up os_id from os_index for each os_codigo
        const { data: osRecords } = await supabase
          .from("os_index")
          .select("os_id, os_codigo")
          .in("os_codigo", osCodigos);
        
        // Deduplicate by os_id (same OS can have multiple orc rows)
        const uniqueOsIds = [...new Set((osRecords || []).map(r => r.os_id))];
        
        for (const osId of uniqueOsIds) {
          try {
            // GET current OS from GC
            const getRes = await callGC<any>({
              endpoint: `/api/ordens_servicos/${osId}`,
            });
            await gcDelay();
            
            const osData = getRes.data?.data ?? getRes.data;
            if (!osData?.id) {
              console.error(`[syncNfse] OS ${osId} não encontrada no GC`);
              erros++;
              continue;
            }

            // Add NF number to observacoes (plural — GC field name)
            const obsOriginal = String(osData.observacoes || osData.observacao || "");
            const nfTag = `NF ${selectedGrupo.nfse_numero}`;
            const novaObs = obsOriginal.includes(nfTag) ? obsOriginal : (obsOriginal ? `${obsOriginal} | ${nfTag}` : nfTag);

            // PUT update — only send required + changed fields (spreading full object causes 404)
            const putPayload: Record<string, any> = {
              tipo: osData.tipo || "servico",
              codigo: osData.codigo,
              cliente_id: osData.cliente_id,
              situacao_id: osData.situacao_id,
              data: osData.data,
              observacoes: novaObs,
            };

            const putRes = await callGC<any>({
              endpoint: `/api/ordens_servicos/${osId}`,
              method: "PUT",
              payload: putPayload,
            });
            await gcDelay();

            if (putRes.status >= 400) {
              console.error(`[syncNfse] Erro PUT OS ${osId}: HTTP ${putRes.status}`);
              erros++;
            } else {
              ok++;
              console.log(`[syncNfse] OS ${osId} atualizada com NF ${selectedGrupo.nfse_numero}`);
            }
          } catch (e) {
            console.error(`[syncNfse] Erro ao atualizar OS ${osId}:`, e);
            erros++;
          }
        }
      }

      queryClient.invalidateQueries({ queryKey: ["fin-grupo-receber-itens", selectedGrupo.id] });
      toast.success(`NFS-e sincronizada no GC: ${ok} atualizados${erros ? `, ${erros} erros` : ""}`);
    } catch (err) {
      toast.error("Erro ao sincronizar NFS-e no GC");
    } finally {
      setSyncingGC(false);
    }
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
          <Button size="sm" variant="outline" onClick={handleScanPassivos} disabled={scanningPassivos}>
            {scanningPassivos ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5 mr-1.5" />}
            Scan Passivos
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowSmartGroup(true)}>
            <Sparkles className="h-3.5 w-3.5 mr-1.5" /> Agrupamento Inteligente
          </Button>
          <Button size="sm" onClick={() => navigate("/financeiro/recebimentos")}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Criar Grupo
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm min-w-[1000px]">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase whitespace-nowrap">Nome</th>
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase whitespace-nowrap">Cliente</th>
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase whitespace-nowrap">OS Vinculadas</th>
              <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase whitespace-nowrap">Valor</th>
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase whitespace-nowrap">Vencimento</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase whitespace-nowrap">Neg./NFS-e</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase whitespace-nowrap">Itens</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase whitespace-nowrap">Status</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase whitespace-nowrap">Baixa GC</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase whitespace-nowrap">Ações</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={10} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></td></tr>
            ) : !grupos?.length ? (
              <tr><td colSpan={10}><EmptyState icon={Layers} title="Nenhum grupo" description="Crie grupos na tela de recebimentos." /></td></tr>
            ) : grupos.map((g: any) => (
              <tr key={g.id} className="border-b border-border hover:bg-muted/30">
                <td className="p-3 font-medium text-foreground">{g.nome}</td>
                <td className="p-3 text-foreground">{g.nome_cliente || "—"}</td>
                <td className="p-3 text-xs">
                  {(g.os_codigos as string[] | null)?.length ? (
                    <div className="flex flex-wrap gap-1">
                      {(g.os_codigos as string[]).map((os: string) => (
                        <Badge key={os} variant="outline" className="text-[10px] font-mono">{os}</Badge>
                      ))}
                    </div>
                  ) : "—"}
                </td>
                <td className="p-3 text-right font-semibold">{formatCurrency(Number(g.valor_total))}</td>
                <td className="p-3">{g.data_vencimento ? formatDate(g.data_vencimento) : "—"}</td>
                <td className="p-3 text-center text-xs">
                  <div className="flex flex-col items-center gap-0.5">
                    {g.negociacao_numero && (
                      <span className="text-muted-foreground">
                        Neg {g.negociacao_numero}
                        {g.nfse_numero ? ` - NF${g.nfse_numero}` : ''}
                      </span>
                    )}
                    {g.nfse_numero ? (
                      g.nfse_link ? (
                        <button onClick={() => handleDownloadXml(g.nfse_link)} className="text-primary hover:underline flex items-center gap-1 justify-center cursor-pointer">
                          <FileText className="h-3 w-3" />{g.nfse_numero}
                        </button>
                      ) : (
                        <span className="flex items-center gap-1 justify-center text-foreground"><FileText className="h-3 w-3" />{g.nfse_numero}</span>
                      )
                    ) : !g.negociacao_numero ? (
                      <span className="text-muted-foreground">—</span>
                    ) : null}
                  </div>
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
                    {canEditGroup(g) && (
                     <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => {
                        setSelectedGrupo(g);
                        setEditNome(g.nome);
                        setEditVencimento(g.data_vencimento || "");
                        setEditObs(g.observacao || "");
                        setEditItensToRemove([]);
                        setEditItensToAdd([]);
                        setSearchReceb("");
                        setSearchResults([]);
                        setEditValorCobrar(null);
                        setShowEditDialog(true);
                      }}>
                          <Pencil className="h-3 w-3" />
                        </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive" onClick={() => {
                      setSelectedGrupo(g);
                      setShowDeleteConfirm(true);
                    }}>
                      <Trash2 className="h-3 w-3" />
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
              <SheetHeader>
                <div className="flex items-center justify-between">
                  <SheetTitle>{selectedGrupo.nome}</SheetTitle>
                  {canEditGroup(selectedGrupo) && (
                    <div className="flex items-center gap-1">
                     <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => {
                        setEditNome(selectedGrupo.nome);
                        setEditVencimento(selectedGrupo.data_vencimento || "");
                        setEditObs(selectedGrupo.observacao || "");
                        setEditItensToRemove([]);
                        setEditItensToAdd([]);
                        setSearchReceb("");
                        setSearchResults([]);
                        setEditValorCobrar(null);
                        setShowEditDialog(true);
                      }}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive" onClick={() => setShowDeleteConfirm(true)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </div>
              </SheetHeader>
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
                  {(selectedGrupo.os_codigos as string[] | null)?.length > 0 && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">OS Vinculadas</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {(selectedGrupo.os_codigos as string[]).map((os: string) => {
                          const osGcId = osIdMap[os];
                          return osGcId ? (
                            <a
                              key={os}
                              href={`${GC_BASE}/ordens_servicos/visualizar/${osGcId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex"
                            >
                              <Badge variant="outline" className="text-xs font-mono cursor-pointer hover:bg-primary/10 hover:border-primary/50">
                                {os} <ExternalLink className="h-2.5 w-2.5 ml-1" />
                              </Badge>
                            </a>
                          ) : (
                            <Badge key={os} variant="outline" className="text-xs font-mono">{os}</Badge>
                          );
                        })}
                      </div>
                    </div>
                  )}
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
                      <div className="col-span-2 flex items-center gap-4 flex-wrap">
                        <button onClick={() => handleOpenNfseGC(selectedGrupo.nfse_numero)} className="text-primary hover:underline flex items-center gap-1 text-sm cursor-pointer">
                          <ExternalLink className="h-3 w-3" /> Ver NFS-e no GC
                        </button>
                        <button onClick={handleOpenGrupoRecebimentosGC} className="text-primary hover:underline flex items-center gap-1 text-sm cursor-pointer">
                          <Search className="h-3 w-3" /> Recebimentos no GC
                        </button>
                        {selectedGrupo.nfse_link && (
                          <button onClick={() => handleDownloadXml(selectedGrupo.nfse_link)} className="text-primary hover:underline flex items-center gap-1 text-sm cursor-pointer">
                            <Link2 className="h-3 w-3" /> Baixar XML
                          </button>
                        )}
                      </div>
                      <div className="col-span-2">
                        <Button variant="outline" size="sm" onClick={handleSyncNfseGC} disabled={syncingGC} className="w-full">
                          {syncingGC ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1.5" />}
                          Sincronizar NFS-e no GC
                        </Button>
                      </div>
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

                {/* Passivos (Residuos) do cliente */}
                {clientePassivos && clientePassivos.length > 0 && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-semibold flex items-center gap-2">
                        <Banknote className="h-4 w-4 text-amber-500" /> Passivos do Cliente ({clientePassivos.length})
                      </h4>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Valores residuais de OS negociadas que ainda não foram utilizados.
                    </p>
                    <div className="space-y-2">
                      {clientePassivos.map((p: any) => (
                        <div key={p.id} className="flex items-center justify-between rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-sm">
                              <span className="font-semibold text-amber-500">{formatCurrency(Number(p.valor_residual))}</span>
                              {p.negociacao_origem_numero && (
                                <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-500">
                                  Neg. nº{p.negociacao_origem_numero}
                                </Badge>
                              )}
                            </div>
                            {p.os_codigos?.length > 0 && (
                              <div className="flex gap-1 mt-1">
                                {p.os_codigos.map((os: string) => (
                                  <Badge key={os} variant="outline" className="text-[9px] font-mono">OS {os}</Badge>
                                ))}
                              </div>
                            )}
                            {p.observacao && (
                              <p className="text-[10px] text-muted-foreground mt-1 truncate">{p.observacao}</p>
                            )}
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs ml-2 shrink-0 border-amber-500/30 hover:bg-amber-500/20"
                            disabled={markingPassivo === p.id}
                            onClick={() => handleMarcarPassivoUtilizado(p.id)}
                          >
                            {markingPassivo === p.id ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
                            Utilizado
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Financeiros vinculados */}
                <div>
                  <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
                    <div>
                      <h4 className="text-sm font-semibold">Financeiros vinculados ({grupoItens?.length || 0})</h4>
                      <p className="text-xs text-muted-foreground">
                        Estes são os recebimentos que compõem o valor combinado do grupo: <span className="font-medium text-foreground">{formatCurrency(grupoItensTotal)}</span>
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        Grupo: {formatCurrency(Number(selectedGrupo.valor_total || 0))}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        Itens: {formatCurrency(grupoItensTotal)}
                      </Badge>
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
                              const osCodigo = item.os_codigo_original || item.fin_recebimentos?.os_codigo;
                              const success = await resyncRecebimentoFromGC(item.fin_recebimentos.gc_id, osCodigo);
                              if (success) ok++; else fail++;
                              await gcDelay();
                            }
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
                  </div>
                  <div className="rounded-md border border-border overflow-x-auto">
                    <table className="w-full min-w-[760px] text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="p-2 text-left whitespace-nowrap">Recebimento GC</th>
                          <th className="p-2 text-left whitespace-nowrap">
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
                          <th className="p-2 text-left whitespace-nowrap">Descrição</th>
                          <th className="p-2 text-right whitespace-nowrap">Valor</th>
                          <th className="p-2 text-center whitespace-nowrap">Pago</th>
                          <th className="p-2 text-center whitespace-nowrap">Baixa GC</th>
                        </tr>
                      </thead>
                      <tbody>
                        {grupoItens?.map((i: any) => {
                          const rec = i.fin_recebimentos;
                          const osOriginal = i.os_codigo_original || rec?.os_codigo;
                          const osGcIdFromMap = osOriginal ? osIdMap[osOriginal] : null;
                          const gcRecebimentoUrl = rec?.gc_id ? `${GC_BASE}/movimentacoes_financeiras/visualizar_recebimento/${rec.gc_id}?retorno=%2Fmovimentacoes_financeiras%2Findex_recebimento` : null;

                          return (
                            <tr key={i.id} className="border-t border-border">
                              <td className="p-2 font-mono">
                                {gcRecebimentoUrl ? (
                                  <a
                                    href={gcRecebimentoUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline inline-flex items-center gap-1"
                                  >
                                    {rec?.gc_codigo || rec?.gc_id}
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                ) : rec?.gc_codigo || "—"}
                              </td>
                              <td className="p-2">
                                {osOriginal ? (
                                  gcOsId ? (
                                    <TooltipProvider>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <a 
                                            href={`https://gestaoclick.com/ordens_servicos/visualizar/${gcOsId}`}
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
                              <td className="p-2 text-right font-medium">
                                {editingItemValor === i.id ? (
                                  <Input
                                    className="h-6 w-24 text-xs text-right ml-auto"
                                    defaultValue={Number(i.valor || rec?.valor).toFixed(2).replace('.', ',')}
                                    autoFocus
                                    onKeyDown={async (e) => {
                                      if (e.key === 'Enter') {
                                        try {
                                          const val = (e.target as HTMLInputElement).value;
                                          const parsed = parseFloat(val.replace(/\./g, "").replace(",", "."));
                                          const valorAtual = Number(i.valor || rec?.valor || 0);
                                          if (isNaN(parsed) || parsed <= 0) { toast.error("Valor inválido"); return; }
                                          if (parsed > valorAtual) { toast.error(`Máximo: ${formatCurrency(valorAtual)}`); return; }
                                          if (Math.abs(parsed - valorAtual) <= 0.009) { setEditingItemValor(null); return; }

                                          // Registra resíduo localmente (não mexe no GC)
                                          await registrarResidualNegociacao({
                                            recebimentoId: i.recebimento_id,
                                            valorOriginal: valorAtual,
                                            valorNegociado: parsed,
                                            clienteGcId: selectedGrupo?.cliente_gc_id || null,
                                            nomeCliente: selectedGrupo?.nome_cliente || null,
                                            osCodigo: rec?.os_codigo || null,
                                            gcRecebimentoId: rec?.gc_id || null,
                                            gcCodigo: rec?.gc_codigo || null,
                                          });

                                          await supabase.from("fin_grupo_receber_itens").update({ valor: parsed }).eq("id", i.id);
                                          const { data: allItens } = await supabase.from("fin_grupo_receber_itens").select("valor").eq("grupo_id", selectedGrupo.id);
                                          const novoTotal = (allItens || []).reduce((s: number, it: any) => s + Number(it.valor || 0), 0);
                                          await supabase.from("fin_grupos_receber").update({ valor_total: novoTotal, updated_at: new Date().toISOString() }).eq("id", selectedGrupo.id);
                                          setSelectedGrupo((prev: any) => prev ? { ...prev, valor_total: novoTotal } : prev);
                                          toast.success(`Valor atualizado para ${formatCurrency(parsed)}`);
                                          queryClient.invalidateQueries({ queryKey: ["fin-grupo-receber-itens"] });
                                          queryClient.invalidateQueries({ queryKey: ["fin-grupos-receber"] });
                                          queryClient.invalidateQueries({ queryKey: ["fin-recebimentos"] });
                                          setEditingItemValor(null);
                                        } catch (err) {
                                          toast.error(err instanceof Error ? err.message : "Erro ao desmembrar item");
                                        }
                                      }
                                      if (e.key === 'Escape') setEditingItemValor(null);
                                    }}
                                    onBlur={() => setEditingItemValor(null)}
                                  />
                                ) : (
                                  <span
                                    className="cursor-pointer hover:text-primary inline-flex items-center gap-1 justify-end"
                                    onClick={() => setEditingItemValor(i.id)}
                                    title="Clique para editar valor"
                                  >
                                    {formatCurrency(Number(i.valor || rec?.valor))}
                                    <Pencil className="h-2.5 w-2.5 text-muted-foreground" />
                                  </span>
                                )}
                              </td>
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

      {/* Edit Group Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-[600px] max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Grupo</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Nome do Grupo</Label>
                <Input value={editNome} onChange={e => setEditNome(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Data de Vencimento</Label>
                <Input type="date" value={editVencimento} onChange={e => setEditVencimento(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Observação</Label>
              <Input value={editObs} onChange={e => setEditObs(e.target.value)} placeholder="Opcional" />
            </div>

            {/* Current items */}
            <div className="space-y-2">
              <Label className="text-sm font-semibold">Itens do Grupo</Label>
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-2 text-left">OS</th>
                      <th className="p-2 text-left">Descrição</th>
                      <th className="p-2 text-right">Valor</th>
                      <th className="p-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {grupoItens?.filter((i: any) => !editItensToRemove.includes(i.id)).map((i: any) => {
                      const rec = i.fin_recebimentos;
                      return (
                        <tr key={i.id} className="border-t border-border">
                          <td className="p-2 font-mono">{i.os_codigo_original || rec?.os_codigo || "—"}</td>
                          <td className="p-2 truncate max-w-[200px]">{rec?.descricao || "—"}</td>
                          <td className="p-2 text-right font-medium">{formatCurrency(Number(i.valor || rec?.valor))}</td>
                          <td className="p-2">
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive" onClick={() => setEditItensToRemove(prev => [...prev, i.id])}>
                              <Minus className="h-3 w-3" />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                    {editItensToAdd.map((rec: any) => (
                      <tr key={rec.id} className="border-t border-border bg-emerald-500/5">
                        <td className="p-2 font-mono">{rec.os_codigo || "—"}</td>
                        <td className="p-2 truncate max-w-[200px]">{rec.descricao || "—"}</td>
                        <td className="p-2 text-right font-medium">{formatCurrency(Number(rec.valor))}</td>
                        <td className="p-2">
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive" onClick={() => setEditItensToAdd(prev => prev.filter(r => r.id !== rec.id))}>
                            <X className="h-3 w-3" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {(!grupoItens?.length && !editItensToAdd.length) && (
                      <tr><td colSpan={4} className="p-3 text-center text-muted-foreground">Nenhum item</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {editItensToRemove.length > 0 && (
                <p className="text-xs text-destructive">{editItensToRemove.length} item(ns) será(ão) removido(s)</p>
              )}
            </div>

            {/* Add new items */}
            <div className="space-y-2">
              <Label className="text-sm font-semibold">Adicionar Recebimentos</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Buscar por OS, código GC ou descrição..."
                  value={searchReceb}
                  onChange={e => handleSearchRecebimentos(e.target.value)}
                  className="pl-8 h-9 text-xs"
                />
                {searchingReceb && <Loader2 className="absolute right-2.5 top-2.5 h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              </div>
              {searchResults.length > 0 && (
                <div className="rounded-md border border-border max-h-[200px] overflow-y-auto">
                  {searchResults.map((rec: any) => (
                    <div key={rec.id} className="flex items-center justify-between px-3 py-2 hover:bg-muted/50 border-b border-border last:border-0 text-xs">
                      <div className="flex-1 min-w-0">
                        <span className="font-mono mr-2">{rec.os_codigo || rec.gc_codigo || "—"}</span>
                        <span className="text-muted-foreground truncate">{rec.descricao}</span>
                        {rec.nome_cliente && <span className="text-muted-foreground ml-2">• {rec.nome_cliente}</span>}
                      </div>
                      <div className="flex items-center gap-2 ml-2 shrink-0">
                        <span className="font-medium">{formatCurrency(Number(rec.valor))}</span>
                        <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => {
                          setEditItensToAdd(prev => [...prev, rec]);
                          setSearchResults(prev => prev.filter(r => r.id !== rec.id));
                        }}>
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Valor a Cobrar / Passivo */}
            {(() => {
              const currentItensTotal = (grupoItens || [])
                .filter((i: any) => !editItensToRemove.includes(i.id))
                .reduce((s: number, i: any) => s + Number(i.valor || i.fin_recebimentos?.valor || 0), 0);
              const addedTotal = editItensToAdd.reduce((s: number, r: any) => s + Number(r.valor || 0), 0);
              const editTotalItens = Math.round((currentItensTotal + addedTotal) * 100) / 100;
              const valorCobrar = editValorCobrar ?? editTotalItens;
              const residual = Math.round((editTotalItens - valorCobrar) * 100) / 100;

              return editTotalItens > 0 ? (
                <div className="space-y-2 rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Total dos itens:</span>
                    <span className="font-semibold">{formatCurrency(editTotalItens)}</span>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Valor a Cobrar</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min={0.01}
                      max={editTotalItens}
                      value={valorCobrar}
                      onChange={(e) => {
                        const v = Math.min(Number(e.target.value), editTotalItens);
                        setEditValorCobrar(Math.round(v * 100) / 100);
                      }}
                      className="h-9"
                    />
                  </div>
                  {residual > 0.01 && (
                    <div className="flex items-center justify-between rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <Banknote className="h-4 w-4 text-amber-500" />
                        <span className="text-muted-foreground">Passivo (valor residual):</span>
                      </div>
                      <span className="font-semibold text-amber-500">{formatCurrency(residual)}</span>
                    </div>
                  )}
                </div>
              ) : null;
            })()}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>Cancelar</Button>
            <Button onClick={handleEditGroup} disabled={saving || !editNome.trim()}>
              {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Excluir Grupo</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Tem certeza que deseja excluir o grupo <strong className="text-foreground">{selectedGrupo?.nome}</strong>? Os recebimentos serão desvinculados mas não excluídos.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>Cancelar</Button>
            <Button variant="destructive" onClick={handleDeleteGroup} disabled={deleting}>
              {deleting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1" />}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SmartGroupDialog open={showSmartGroup} onOpenChange={setShowSmartGroup} />
    </div>
  );
}
