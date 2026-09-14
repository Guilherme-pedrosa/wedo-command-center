import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { alterarSituacaoComissoes, carregarConferenciasComissoes } from '@/lib/comissoes/api';
import type { DadosVenda, calcularVenda } from '@/lib/comissoes/calculo';
import { formatBRL } from '@/lib/comissoes/analisePickPack';

interface Props {
  linhas: ReturnType<typeof calcularVenda>[];
  retirada: boolean;
  onClose: () => void;
}

export function AlterarSituacaoComissoesDialog({ linhas, retirada, onClose }: Props) {
  const [motivo, setMotivo] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [registrada, setRegistrada] = useState<{ alteradas: number; solicitadas: number } | null>(null);
  const qc = useQueryClient();
  const total = linhas.reduce((s, r) => s + r.comissaoCalculada, 0);
  async function confirmar() {
    if (!motivo.trim() || !linhas.length || linhas.length > 200) return;
    setSalvando(true);
    let resultado = registrada;
    try {
      const ids = linhas.map(r => r.venda.id as string);
      if (!resultado) {
        resultado = await alterarSituacaoComissoes(ids, retirada, motivo.trim());
        setRegistrada(resultado);
      }
      // A situação é local. Não refazer a consulta de todo o GC ao retirar uma comissão.
      const conferencias = await carregarConferenciasComissoes(ids);
      qc.setQueriesData<{ vendas: DadosVenda[] }>({ queryKey: ['comissoes'] }, anterior => anterior && ({
        ...anterior,
        vendas: anterior.vendas.map(v => ({ ...v, conferencia: conferencias.find(c => c.venda_id === v.venda.id) ?? v.conferencia })),
      }));
      await qc.invalidateQueries({ queryKey: ['comissao-historico'] });
      toast.success(`${resultado.alteradas} comissão(ões) ${retirada ? 'retirada(s)' : 'reincluída(s)'}. Motivo registrado no histórico.`);
      onClose();
    } catch (e) {
      toast.error(`${resultado ? 'Alteração registrada. Falhou apenas a atualização da tela' : 'Não foi possível registrar a alteração'}: ${(e as Error).message}`);
    } finally { setSalvando(false); }
  }
  function fechar() {
    if (salvando) return;
    if (registrada) void qc.invalidateQueries({ queryKey: ['comissoes'] });
    onClose();
  }
  return <Dialog open onOpenChange={aberto => { if (!aberto) fechar(); }}>
    <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{retirada ? 'Retirar comissão' : 'Reincluir comissão'} — {linhas.length} venda(s)</DialogTitle></DialogHeader>
      <DialogDescription className="text-sm">{retirada ? 'As vendas continuam na conferência. A comissão devida dessas vendas passa a zero.' : 'As vendas voltam a ter comissão conforme os valores e as regras atuais.'}</DialogDescription>
      <div className="max-h-48 overflow-y-auto rounded border divide-y">
        {linhas.map(r => <p key={r.venda.id} className="p-2 text-sm"><b>{r.venda.codigo} · {r.vendedor || 'Sem vendedor'}</b><br/>{r.venda.nome_cliente}<span className="float-right">{formatBRL(r.comissaoCalculada)}</span></p>)}
      </div>
      {linhas.length > 200 && <p role="alert" className="text-sm text-destructive">Selecione até 200 vendas por operação. Reduza a seleção para continuar.</p>}
      <p className="font-medium">Comissão calculada das vendas: {formatBRL(total)}</p>
      {linhas.some(r => r.pago > 0) && <p role="status" className="text-sm text-amber-500">Há pagamentos de comissão já registrados. Eles permanecem no histórico; a retirada pode gerar um saldo que precisa de ajuste.</p>}
      {registrada && <p role="status" className="text-sm text-amber-500">A alteração já foi registrada. Atualize a tela para conferir os novos valores; o botão abaixo consulta o resultado sem repetir a retirada ou reinclusão.</p>}
      <label className="text-sm space-y-2">Motivo obrigatório<Textarea value={motivo} onChange={e => setMotivo(e.target.value)} maxLength={2000} disabled={salvando || !!registrada} placeholder={retirada ? 'Explique por que estas vendas não devem gerar comissão.' : 'Explique por que estas vendas devem voltar à comissão.'}/></label>
      <p className="text-xs text-muted-foreground">A alteração registra seu usuário, data e motivo. A reinclusão exige uma nova conferência antes de registrar pagamento.</p>
      <div className="flex justify-end gap-2"><Button variant="outline" onClick={fechar} disabled={salvando}>{registrada ? 'Fechar' : 'Cancelar'}</Button><Button variant={retirada ? 'destructive' : 'default'} disabled={salvando || !motivo.trim() || !linhas.length || linhas.length > 200} onClick={() => void confirmar()}>{salvando ? 'Atualizando…' : registrada ? 'Atualizar tela' : retirada ? 'Confirmar retirada' : 'Confirmar reinclusão'}</Button></div>
    </DialogContent>
  </Dialog>;
}
