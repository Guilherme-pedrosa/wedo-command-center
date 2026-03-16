import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { RotateCcw } from 'lucide-react';

interface RetornoDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (tecnicoRetorno: string, observacao: string) => void;
  osCodigo: string;
  tecnicoOriginal: string;
  valor: number;
  tecnicos: string[];
}

const formatBRL = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

export function RetornoDialog({
  open,
  onClose,
  onConfirm,
  osCodigo,
  tecnicoOriginal,
  valor,
  tecnicos,
}: RetornoDialogProps) {
  const [selected, setSelected] = useState('');
  const outrosTecnicos = tecnicos.filter(
    (t) => t.toUpperCase() !== tecnicoOriginal.toUpperCase()
  );

  const handleConfirm = () => {
    if (selected) {
      onConfirm(selected);
      setSelected('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md bg-[#0f1629] border-white/10 text-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white">
            <RotateCcw className="h-5 w-5 text-orange-400" />
            Marcar como Retorno
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="text-sm text-white/60">
            <p>
              OS <strong className="text-white">{osCodigo}</strong> •{' '}
              {formatBRL(valor)}
            </p>
            <p>
              Técnico original:{' '}
              <strong className="text-white">{tecnicoOriginal}</strong>
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-white/80">
              Técnico que atendeu o retorno
            </label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white">
                <SelectValue placeholder="Selecione o técnico..." />
              </SelectTrigger>
              <SelectContent className="bg-[#1a2035] border-white/10">
                {outrosTecnicos.map((t) => (
                  <SelectItem key={t} value={t} className="text-white">
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} className="text-white/60">
            Cancelar
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!selected}
            className="bg-orange-500 hover:bg-orange-600 text-white"
          >
            Confirmar Retorno
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
