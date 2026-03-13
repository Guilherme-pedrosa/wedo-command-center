import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KanbanBoard } from "@/components/argus/KanbanBoard";
import { RadarPanel } from "@/components/argus/RadarPanel";
import { RunsPanel } from "@/components/argus/RunsPanel";
import { AprovacaoPanel } from "@/components/argus/AprovacaoPanel";
import { LayoutDashboard, Radar, Play, ShieldCheck } from "lucide-react";

export default function ArgusAgentPage() {
  const [tab, setTab] = useState("kanban");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Radar className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">ARGUS Finance OS</h1>
          <p className="text-sm text-muted-foreground">Agente financeiro preventivo, preditivo e corretivo</p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList>
          <TabsTrigger value="kanban" className="gap-1.5">
            <LayoutDashboard className="h-4 w-4" /> Kanban
          </TabsTrigger>
          <TabsTrigger value="radar" className="gap-1.5">
            <Radar className="h-4 w-4" /> Radar
          </TabsTrigger>
          <TabsTrigger value="runs" className="gap-1.5">
            <Play className="h-4 w-4" /> Execuções
          </TabsTrigger>
          <TabsTrigger value="aprovacoes" className="gap-1.5">
            <ShieldCheck className="h-4 w-4" /> Aprovações
          </TabsTrigger>
        </TabsList>

        <TabsContent value="kanban" className="mt-4">
          <KanbanBoard />
        </TabsContent>
        <TabsContent value="radar" className="mt-4">
          <RadarPanel />
        </TabsContent>
        <TabsContent value="runs" className="mt-4">
          <RunsPanel />
        </TabsContent>
        <TabsContent value="aprovacoes" className="mt-4">
          <AprovacaoPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
