import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Settings, TestTube, Save, RefreshCw, Database, CheckCircle, XCircle, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { testGCConnection } from "@/lib/gc-client";
import { syncRecebimentos, syncPagamentos } from "@/api/syncService";

export default function Configuracoes() {
  const queryClient = useQueryClient();

  // Load config from DB
  const { data: config } = useQuery({
    queryKey: ["configuracoes"],
    queryFn: async () => {
      const { data } = await supabase.from("configuracoes").select("*");
      const map: Record<string, string> = {};
      data?.forEach((c) => { if (c.valor) map[c.chave] = c.valor; });
      return map;
    },
  });

  const [syncEnabled, setSyncEnabled] = useState(true);
  const [syncInterval, setSyncInterval] = useState("30");
  const [pickingTtl, setPickingTtl] = useState("5");
  const [confirmMode, setConfirmMode] = useState("texto");
  const [interPixKey, setInterPixKey] = useState("");

  useEffect(() => {
    if (config) {
      setSyncEnabled(config.auto_sync_enabled !== "false");
      setSyncInterval(config.sync_interval_min || "30");
      setPickingTtl(config.picking_ttl_min || "5");
      setConfirmMode(config.confirm_mode || "texto");
      setInterPixKey(config.inter_pix_key || "");
    }
  }, [config]);

  // GC test state
  const [gcTesting, setGcTesting] = useState(false);
  const [gcTestResult, setGcTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [syncing, setSyncing] = useState(false);

  const handleTestGC = async () => {
    setGcTesting(true);
    setGcTestResult(null);
    try {
      const result = await testGCConnection();
      setGcTestResult(result);
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro desconhecido";
      setGcTestResult({ ok: false, message: msg });
      toast.error(msg);
    } finally {
      setGcTesting(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const [r, p] = await Promise.all([syncRecebimentos(), syncPagamentos()]);
      toast.success(`Sincronizado: ${r.importados} receb., ${p.importados} pagam.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro");
    } finally {
      setSyncing(false);
    }
  };

  const saveConfig = async (chave: string, valor: string) => {
    await supabase.from("configuracoes").upsert({ chave, valor }, { onConflict: "chave" });
    queryClient.invalidateQueries({ queryKey: ["configuracoes"] });
  };

  const handleSaveAll = async () => {
    await Promise.all([
      saveConfig("auto_sync_enabled", String(syncEnabled)),
      saveConfig("sync_interval_min", syncInterval),
      saveConfig("picking_ttl_min", pickingTtl),
      saveConfig("confirm_mode", confirmMode),
      saveConfig("inter_pix_key", interPixKey),
    ]);
    toast.success("Configurações salvas");
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Configurações</h1>
          <p className="text-sm text-muted-foreground">Gerencie as integrações e comportamento do sistema</p>
        </div>
        <Button size="sm" onClick={handleSaveAll}>
          <Save className="h-3.5 w-3.5 mr-1.5" /> Salvar Tudo
        </Button>
      </div>

      <Accordion type="multiple" defaultValue={["gc", "inter", "sync", "picking", "confirm"]} className="space-y-3">
        {/* GestãoClick */}
        <AccordionItem value="gc" className="rounded-lg border border-border bg-card px-4">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline">API GestãoClick</AccordionTrigger>
          <AccordionContent className="space-y-4 pb-4">
            <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              As credenciais do GestãoClick estão armazenadas como <strong>Cloud Secrets</strong> (GC_ACCESS_TOKEN, GC_SECRET_TOKEN). Para alterá-las, atualize os secrets no painel do Lovable Cloud.
            </div>
            {gcTestResult && (
              <div className={`flex items-center gap-2 rounded-md p-3 text-sm ${gcTestResult.ok ? "bg-wedo-green/10 text-wedo-green" : "bg-wedo-red/10 text-wedo-red"}`}>
                {gcTestResult.ok ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                {gcTestResult.message}
              </div>
            )}
            <Button size="sm" variant="outline" onClick={handleTestGC} disabled={gcTesting}>
              {gcTesting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <TestTube className="h-3.5 w-3.5 mr-1.5" />}
              {gcTesting ? "Testando..." : "Testar conexão"}
            </Button>
          </AccordionContent>
        </AccordionItem>

        {/* Banco Inter */}
        <AccordionItem value="inter" className="rounded-lg border border-border bg-card px-4">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline">API Banco Inter</AccordionTrigger>
          <AccordionContent className="space-y-4 pb-4">
            <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              A integração com Banco Inter requer certificados mTLS. Configure os secrets INTER_CLIENT_ID, INTER_CLIENT_SECRET, INTER_CERT e INTER_KEY no Lovable Cloud.
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Chave PIX (para cobranças)</Label>
              <Input value={interPixKey} onChange={(e) => setInterPixKey(e.target.value)} placeholder="Chave PIX para cobranças" />
            </div>
            <Button size="sm" variant="outline" disabled>
              <TestTube className="h-3.5 w-3.5 mr-1.5" /> Testar conexão
            </Button>
          </AccordionContent>
        </AccordionItem>

        {/* Sync */}
        <AccordionItem value="sync" className="rounded-lg border border-border bg-card px-4">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline">Sincronização Automática</AccordionTrigger>
          <AccordionContent className="space-y-4 pb-4">
            <div className="flex items-center gap-3">
              <Switch checked={syncEnabled} onCheckedChange={setSyncEnabled} />
              <Label className="text-sm">Sincronizar automaticamente</Label>
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Intervalo (minutos)</Label>
              <Select value={syncInterval} onValueChange={setSyncInterval}>
                <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">5 min</SelectItem>
                  <SelectItem value="10">10 min</SelectItem>
                  <SelectItem value="15">15 min</SelectItem>
                  <SelectItem value="30">30 min</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" variant="outline" onClick={handleSyncNow} disabled={syncing}>
              {syncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
              Sincronizar agora
            </Button>
          </AccordionContent>
        </AccordionItem>

        {/* Picking */}
        <AccordionItem value="picking" className="rounded-lg border border-border bg-card px-4">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline">Picking</AccordionTrigger>
          <AccordionContent className="space-y-4 pb-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">TTL do índice (minutos)</Label>
              <Input type="number" value={pickingTtl} onChange={(e) => setPickingTtl(e.target.value)} className="w-[120px]" />
            </div>
            <Button size="sm" variant="outline">
              <Database className="h-3.5 w-3.5 mr-1.5" /> Reconstruir índice agora
            </Button>
          </AccordionContent>
        </AccordionItem>

        {/* Confirmações */}
        <AccordionItem value="confirm" className="rounded-lg border border-border bg-card px-4">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline">Confirmações</AccordionTrigger>
          <AccordionContent className="space-y-4 pb-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Modo de confirmação para quitações</Label>
              <Select value={confirmMode} onValueChange={setConfirmMode}>
                <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="texto">Digitar CONFIRMAR</SelectItem>
                  <SelectItem value="click">Apenas clique (não recomendado)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
