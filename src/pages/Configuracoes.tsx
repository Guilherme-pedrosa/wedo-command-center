import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Settings, TestTube, Save, RefreshCw, Database } from "lucide-react";
import toast from "react-hot-toast";

export default function Configuracoes() {
  const [gcAccess, setGcAccess] = useState("");
  const [gcSecret, setGcSecret] = useState("");
  const [interClientId, setInterClientId] = useState("");
  const [interClientSecret, setInterClientSecret] = useState("");
  const [interPixKey, setInterPixKey] = useState("");
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [syncInterval, setSyncInterval] = useState("5");
  const [pickingTtl, setPickingTtl] = useState("5");
  const [confirmMode, setConfirmMode] = useState("texto");

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Configurações</h1>
        <p className="text-sm text-muted-foreground">Gerencie as integrações e comportamento do sistema</p>
      </div>

      <Accordion type="multiple" defaultValue={["gc", "inter", "sync", "picking", "confirm"]} className="space-y-3">
        {/* GestãoClick */}
        <AccordionItem value="gc" className="rounded-lg border border-border bg-card px-4">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline">
            API GestãoClick
          </AccordionTrigger>
          <AccordionContent className="space-y-4 pb-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Access Token</Label>
              <Input type="password" value={gcAccess} onChange={(e) => setGcAccess(e.target.value)} placeholder="Cole seu access-token" />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Secret Access Token</Label>
              <Input type="password" value={gcSecret} onChange={(e) => setGcSecret(e.target.value)} placeholder="Cole seu secret-access-token" />
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline">
                <TestTube className="h-3.5 w-3.5 mr-1.5" />
                Testar conexão
              </Button>
              <Button size="sm">
                <Save className="h-3.5 w-3.5 mr-1.5" />
                Salvar
              </Button>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Banco Inter */}
        <AccordionItem value="inter" className="rounded-lg border border-border bg-card px-4">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline">
            API Banco Inter
          </AccordionTrigger>
          <AccordionContent className="space-y-4 pb-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Client ID</Label>
              <Input value={interClientId} onChange={(e) => setInterClientId(e.target.value)} placeholder="Client ID" />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Client Secret</Label>
              <Input type="password" value={interClientSecret} onChange={(e) => setInterClientSecret(e.target.value)} placeholder="Client Secret" />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Chave PIX</Label>
              <Input value={interPixKey} onChange={(e) => setInterPixKey(e.target.value)} placeholder="Chave PIX para cobranças" />
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline">
                <TestTube className="h-3.5 w-3.5 mr-1.5" />
                Testar conexão
              </Button>
              <Button size="sm">
                <Save className="h-3.5 w-3.5 mr-1.5" />
                Salvar
              </Button>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Sync */}
        <AccordionItem value="sync" className="rounded-lg border border-border bg-card px-4">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline">
            Sincronização Automática
          </AccordionTrigger>
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
            <Button size="sm" variant="outline">
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              Sincronizar agora
            </Button>
          </AccordionContent>
        </AccordionItem>

        {/* Picking */}
        <AccordionItem value="picking" className="rounded-lg border border-border bg-card px-4">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline">
            Picking
          </AccordionTrigger>
          <AccordionContent className="space-y-4 pb-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">TTL do índice (minutos)</Label>
              <Input type="number" value={pickingTtl} onChange={(e) => setPickingTtl(e.target.value)} className="w-[120px]" />
            </div>
            <Button size="sm" variant="outline">
              <Database className="h-3.5 w-3.5 mr-1.5" />
              Reconstruir índice agora
            </Button>
          </AccordionContent>
        </AccordionItem>

        {/* Confirmações */}
        <AccordionItem value="confirm" className="rounded-lg border border-border bg-card px-4">
          <AccordionTrigger className="text-sm font-semibold hover:no-underline">
            Confirmações
          </AccordionTrigger>
          <AccordionContent className="space-y-4 pb-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Modo de confirmação para quitações</Label>
              <Select value={confirmMode} onValueChange={setConfirmMode}>
                <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="texto">Digitar CONFIRMAR</SelectItem>
                  <SelectItem value="click">Apenas clique</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
