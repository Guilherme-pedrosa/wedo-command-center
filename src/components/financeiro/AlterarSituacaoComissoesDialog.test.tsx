import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlterarSituacaoComissoesDialog } from './AlterarSituacaoComissoesDialog';
import type { Conferencia, DadosVenda, calcularVenda } from '@/lib/comissoes/calculo';

const mocks = vi.hoisted(() => ({ alterar: vi.fn(), carregar: vi.fn(), sucesso: vi.fn(), erro: vi.fn() }));
vi.mock('@/lib/comissoes/api', () => ({ alterarSituacaoComissoes: mocks.alterar, carregarConferenciasComissoes: mocks.carregar }));
vi.mock('react-hot-toast', () => ({ default: { success: mocks.sucesso, error: mocks.erro } }));

type Linha = ReturnType<typeof calcularVenda>;
function linha(id: string): Linha {
  return {
    venda: { id, codigo: `1773530${id}`, nome_cliente: `Cliente ${id}` },
    vendedor: 'Filipe', comissaoCalculada: 50, comissao: 50, pago: 0,
    recebimentos: [{ gc_id: `titulo-${id}`, valor_total: 1000, liquidado: true }],
    pagamentos: [], conferencia: { venda_id: id, ajustes: { custoAdicional: 12 }, conferido: true, assinatura: 'conferida' },
  } as unknown as Linha;
}

const novaConferencia: Conferencia = {
  venda_id: '10', ajustes: { custoAdicional: 12 }, conferido: false, assinatura: '', retirada: true,
  motivo_retirada: 'Atendimento pendente', situacao_alterada_em: '2026-09-14T19:00:00Z', situacao_alterada_por: 'administrador',
};
let client: QueryClient;
let subscriptions: (() => void)[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.alterar.mockReset().mockResolvedValue({ alteradas: 1, solicitadas: 1 });
  mocks.carregar.mockReset().mockResolvedValue([novaConferencia]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  subscriptions = [];
});
afterEach(() => {
  cleanup();
  subscriptions.forEach(unsubscribe => unsubscribe());
  client.clear();
});

function abrir(retirada = true, linhas = [linha('10')]) {
  const onClose = vi.fn();
  render(<QueryClientProvider client={client}><AlterarSituacaoComissoesDialog linhas={linhas} retirada={retirada} onClose={onClose} /></QueryClientProvider>);
  return onClose;
}

function observarGC(queryKey: string[], dados: { vendas: DadosVenda[]; [key: string]: unknown }) {
  client.setQueryData(queryKey, dados);
  const buscarGC = vi.fn().mockResolvedValue(dados);
  const observer = new QueryObserver(client, { queryKey, queryFn: buscarGC, staleTime: Infinity });
  subscriptions.push(observer.subscribe(() => {}));
  return buscarGC;
}

describe('retirada e reinclusão de comissões', () => {
  it.each([true, false])('exige motivo não vazio antes de confirmar (retirada=%s)', retirada => {
    abrir(retirada);
    const confirmar = screen.getByRole('button', { name: retirada ? 'Confirmar retirada' : 'Confirmar reinclusão' });
    expect(confirmar).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Motivo obrigatório'), { target: { value: '   ' } });
    expect(confirmar).toBeDisabled();
    fireEvent.click(confirmar);
    expect(mocks.alterar).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Motivo obrigatório'), { target: { value: 'Motivo informado' } });
    expect(confirmar).toBeEnabled();
  });

  it('atualiza todas as consultas locais preservando outras vendas e metadados, sem buscar novamente no GC', async () => {
    const setembro = ['comissoes', '2026-09-01', '2026-09-30'];
    const trimestre = ['comissoes', '2026-07-01', '2026-09-30'];
    const outraVenda = linha('11');
    const dados = { vendas: [linha('10'), outraVenda], parametros: { config: { impostoPct: 14 } }, fretes: [{ id: 'compra:10' }],
      rateios: [{ venda_id: '11' }], origemConsulta: 'gc', avisoFretes: 'Última leitura preservada' };
    const dadosTrimestre = { ...dados, vendas: [linha('10'), linha('12')], marcador: 'outra consulta' };
    const gcSetembro = observarGC(setembro, dados);
    const gcTrimestre = observarGC(trimestre, dadosTrimestre);
    const clientes = { vendas: [linha('10')], marcador: 'não é consulta de comissões' };
    client.setQueryData(['clientes'], clientes);
    const fechar = abrir();
    fireEvent.change(screen.getByLabelText('Motivo obrigatório'), { target: { value: '  Atendimento pendente  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar retirada' }));
    await waitFor(() => expect(fechar).toHaveBeenCalledTimes(1));

    expect(mocks.alterar).toHaveBeenCalledExactlyOnceWith(['10'], true, 'Atendimento pendente');
    expect(mocks.carregar).toHaveBeenCalledExactlyOnceWith(['10']);
    const atualizado = client.getQueryData<typeof dados>(setembro)!;
    expect(atualizado.vendas[0].conferencia).toEqual(novaConferencia);
    expect(atualizado.vendas[0].recebimentos).toBe(dados.vendas[0].recebimentos);
    expect(atualizado.vendas[1]).toEqual(outraVenda);
    expect(atualizado.parametros).toBe(dados.parametros);
    expect(atualizado.fretes).toBe(dados.fretes);
    expect(atualizado.rateios).toBe(dados.rateios);
    expect(atualizado.origemConsulta).toBe('gc');
    expect(atualizado.avisoFretes).toBe(dados.avisoFretes);
    expect(client.getQueryData<typeof dadosTrimestre>(trimestre)).toEqual({ ...dadosTrimestre,
      vendas: [{ ...dadosTrimestre.vendas[0], conferencia: novaConferencia }, dadosTrimestre.vendas[1]],
    });
    expect(client.getQueryData(['clientes'])).toBe(clientes);
    expect(gcSetembro).not.toHaveBeenCalled();
    expect(gcTrimestre).not.toHaveBeenCalled();
    expect(mocks.sucesso).toHaveBeenCalledWith(expect.stringContaining('Motivo registrado no histórico'));
  });

  it('após escrita bem-sucedida e falha de leitura informa o registro e repete somente a leitura', async () => {
    const queryKey = ['comissoes', '2026-09-01', '2026-09-30'];
    const dados = { vendas: [linha('10'), linha('11')], origemConsulta: 'gc', avisoFretes: '' };
    const buscarGC = observarGC(queryKey, dados);
    mocks.carregar.mockRejectedValueOnce(new Error('Rede indisponível')).mockResolvedValueOnce([novaConferencia]);
    const fechar = abrir();
    fireEvent.change(screen.getByLabelText('Motivo obrigatório'), { target: { value: 'Atendimento pendente' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar retirada' }));
    await waitFor(() => expect(mocks.erro).toHaveBeenCalledWith('Alteração registrada. Falhou apenas a atualização da tela: Rede indisponível'));

    expect(screen.getByText(/A alteração já foi registrada/)).toBeInTheDocument();
    expect(screen.getByLabelText('Motivo obrigatório')).toBeDisabled();
    expect(fechar).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKey)).toBe(dados);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar tela' }));
    await waitFor(() => expect(fechar).toHaveBeenCalledTimes(1));
    expect(mocks.alterar).toHaveBeenCalledTimes(1);
    expect(mocks.carregar).toHaveBeenCalledTimes(2);
    expect(mocks.carregar).toHaveBeenNthCalledWith(1, ['10']);
    expect(mocks.carregar).toHaveBeenNthCalledWith(2, ['10']);
    expect(client.getQueryData<typeof dados>(queryKey)?.vendas[0].conferencia).toEqual(novaConferencia);
    expect(client.getQueryData<typeof dados>(queryKey)?.vendas[1]).toEqual(dados.vendas[1]);
    expect(buscarGC).not.toHaveBeenCalled();
    expect(mocks.sucesso).toHaveBeenCalledTimes(1);
  });

  it('falha da escrita mantém o motivo editável e não afirma que houve alteração', async () => {
    mocks.alterar.mockRejectedValueOnce(new Error('Sem permissão'));
    const fechar = abrir(false);
    fireEvent.change(screen.getByLabelText('Motivo obrigatório'), { target: { value: 'Revisão concluída' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar reinclusão' }));
    await waitFor(() => expect(mocks.erro).toHaveBeenCalledWith('Não foi possível registrar a alteração: Sem permissão'));
    expect(mocks.carregar).not.toHaveBeenCalled();
    expect(screen.queryByText(/A alteração já foi registrada/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Motivo obrigatório')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Confirmar reinclusão' })).toBeEnabled();
    expect(fechar).not.toHaveBeenCalled();
  });
});
