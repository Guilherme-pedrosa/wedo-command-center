import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PainelComissoesVendedor } from './PainelComissoesVendedor';
import type { calcularVenda } from '@/lib/comissoes/calculo';

type Linha = ReturnType<typeof calcularVenda>;

function venda(id: string, patch: Partial<Linha> = {}): Linha {
  return {
    venda: { id, gc_id: id, codigo: id, nome_cliente: `Cliente ${id}`, data: '2026-09-14', nome_situacao: 'Concretizada' },
    vendedor: 'Filipe', vendedorChave: 'gc:1', a: { receitaLiquida: 1000 },
    base: 1000, percentual: 5, comissaoCalculada: 50, comissao: 50,
    retirada: false, pago: 0, saldo: 50, recebimento: 'Recebido', formas: ['PIX'], avisos: [],
    conferencia: null, ...patch,
  } as Linha;
}

afterEach(cleanup);

describe('Painel por vendedor', () => {
  it('mantém vendedores homônimos separados pela identidade do GC', () => {
    render(<PainelComissoesVendedor linhas={[venda('10'), venda('11', { vendedorChave: 'gc:2' })]} isAdmin onConferir={vi.fn()} onAlterarSituacao={vi.fn()} />);
    expect(screen.getAllByRole('region', { name: 'Filipe' })).toHaveLength(2);
  });

  it('altera somente as selecionadas aplicáveis e limpa seleção ao disparar', () => {
    const alterar = vi.fn();
    render(<PainelComissoesVendedor linhas={[
      venda('10'), venda('11', { retirada: true, comissao: 0, saldo: 0 }),
      venda('12', { vendedor: 'Igor', vendedorChave: 'gc:2' }),
    ]} isAdmin onConferir={vi.fn()} onAlterarSituacao={alterar} />);
    fireEvent.click(screen.getByRole('button', { name: /Filipe/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar todas as 2 vendas exibidas de Filipe' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retirar comissões (1)' }));
    expect(alterar).toHaveBeenCalledExactlyOnceWith(['10'], true);
    expect(screen.getByRole('button', { name: 'Retirar comissões (0)' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar venda 11 de Cliente 11' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reincluir comissões (1)' }));
    expect(alterar).toHaveBeenLastCalledWith(['11'], false);
  });

  it('descarta a seleção quando filtros ocultam uma venda, inclusive ao voltar ao filtro anterior', () => {
    const linhas = [venda('10'), venda('11')];
    const props = { isAdmin: true, onConferir: vi.fn(), onAlterarSituacao: vi.fn() };
    const { rerender } = render(<PainelComissoesVendedor {...props} linhas={linhas} />);
    fireEvent.click(screen.getByRole('button', { name: /Filipe/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar venda 10 de Cliente 10' }));
    rerender(<PainelComissoesVendedor {...props} linhas={[linhas[1]]} />);
    expect(screen.getByRole('button', { name: 'Retirar comissões (0)' })).toBeDisabled();
    rerender(<PainelComissoesVendedor {...props} linhas={linhas} />);
    expect(screen.getByRole('checkbox', { name: 'Selecionar venda 10 de Cliente 10' })).not.toBeChecked();
  });

  it('bloqueia somente o tipo de ação acima de 200 sem truncar a seleção', () => {
    const alterar = vi.fn();
    const linhas = [...Array.from({ length: 201 }, (_, indice) => venda(String(indice))),
      venda('retirada', { retirada: true, comissao: 0, saldo: 0 })];
    render(<PainelComissoesVendedor linhas={linhas} isAdmin onConferir={vi.fn()} onAlterarSituacao={alterar} />);
    fireEvent.click(screen.getByRole('button', { name: /Filipe/ }));
    fireEvent.click(screen.getByLabelText('Selecionar todas as 202 vendas exibidas de Filipe'));
    expect(screen.getByText('Retirar comissões (201)')).toBeDisabled();
    expect(screen.getByText('Reincluir comissões (1)')).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('A seleção foi mantida');
    expect(screen.getByLabelText('Selecionar venda 200 de Cliente 200')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Selecionar venda 200 de Cliente 200'));
    expect(screen.getByText('Retirar comissões (200)')).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Retirar comissões (200)'));
    expect(alterar).toHaveBeenCalledExactlyOnceWith(Array.from({ length: 200 }, (_, indice) => String(indice)), true);
  }, 15000);

  it('mantém pagamentos de retiradas e separa valor a conferir do saldo das outras vendas', () => {
    render(<PainelComissoesVendedor linhas={[
      venda('10'), venda('11', { retirada: true, comissao: 0, pago: 20, saldo: -20,
        conferencia: { venda_id: '11', ajustes: {}, conferido: false, motivo_retirada: 'Venda devolvida' } }),
    ]} isAdmin onConferir={vi.fn()} onAlterarSituacao={vi.fn()} />);
    const saldo = screen.getByText('Saldo a pagar').parentElement!;
    expect(within(saldo).getByText(/50,00/)).toBeInTheDocument();
    expect(screen.getByText(/20,00 em pagamentos acima/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Filipe/ }));
    expect(screen.getByText('Venda devolvida')).toBeInTheDocument();
    expect(screen.getByText('Retirada · pagamento registrado')).toBeInTheDocument();
    expect(screen.getByText(/Pago: R\$\s*20,00/)).toBeInTheDocument();
  });

  it('permite conferir em leitura sem oferecer ações administrativas', () => {
    const conferir = vi.fn();
    render(<PainelComissoesVendedor linhas={[venda('10')]} isAdmin={false} onConferir={conferir} onAlterarSituacao={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Filipe/ }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retirar comissão/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Conferir venda 10' }));
    expect(conferir).toHaveBeenCalledExactlyOnceWith('10');
  });
});
