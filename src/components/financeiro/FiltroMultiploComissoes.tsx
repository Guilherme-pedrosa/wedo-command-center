import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChevronDown } from 'lucide-react';

export function FiltroMultiploComissoes({ label, opcoes, selecionados, onChange }: {
  label: string;
  opcoes: { valor: string; nome: string }[];
  selecionados: string[];
  onChange: (valores: string[]) => void;
}) {
  return <Popover><PopoverTrigger asChild>
    <Button variant="outline" aria-label={label} className="justify-between gap-3">
      {label}: {selecionados.length ? `${selecionados.length} selecionado(s)` : 'Todos'}<ChevronDown className="h-4 w-4"/>
    </Button>
  </PopoverTrigger><PopoverContent align="start" className="w-80 p-3">
    <p className="font-medium mb-2">{label}</p>
    <div className="flex gap-2 mb-2">
      <Button size="sm" variant="ghost" onClick={()=>onChange(opcoes.map(o=>o.valor))}>Selecionar todos</Button>
      <Button size="sm" variant="ghost" onClick={()=>onChange([])}>Limpar</Button>
    </div>
    <div className="max-h-72 overflow-y-auto space-y-1">
      {opcoes.map(o=><label key={o.valor} className="flex gap-2 items-start rounded p-2 hover:bg-muted cursor-pointer text-sm">
        <input type="checkbox" className="mt-1" checked={selecionados.includes(o.valor)} onChange={e=>onChange(e.target.checked ? [...selecionados,o.valor] : selecionados.filter(v=>v!==o.valor))}/>
        {o.nome}
      </label>)}
    </div>
    <p className="text-xs text-muted-foreground mt-2">Sem seleção, exibe todos. Seleções deste filtro são combinadas entre si.</p>
  </PopoverContent></Popover>;
}
