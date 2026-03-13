import { RotateCcw, Undo2 } from 'lucide-react';

interface OsItem {
  codigo: string;
  valor: number;
  isRetorno?: boolean;
  retornoFrom?: string;
}

interface TecnicoCardProps {
  nome: string;
  meta: number;
  realizado: number;
  pct: number;
  osList: OsItem[];
  rank: number;
  isLoggedIn: boolean;
  onMarkRetorno?: (osCodigo: string, valor: number) => void;
  onUndoRetorno?: (osCodigo: string) => void;
}

const formatBRL = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

const getEmoji = (pct: number) => {
  if (pct >= 1) return '🏆';
  if (pct >= 0.8) return '😄';
  if (pct >= 0.5) return '😐';
  return '😟';
};

const getBarColor = (pct: number) => {
  if (pct >= 1) return 'bg-emerald-500';
  if (pct >= 0.8) return 'bg-yellow-400';
  if (pct >= 0.5) return 'bg-orange-400';
  return 'bg-red-500';
};

const getTextColor = (pct: number) => {
  if (pct >= 1) return 'text-emerald-400';
  if (pct >= 0.8) return 'text-yellow-400';
  if (pct >= 0.5) return 'text-orange-400';
  return 'text-red-400';
};

export function TecnicoCard({
  nome,
  meta,
  realizado,
  pct,
  osList,
  rank,
  isLoggedIn,
  onMarkRetorno,
  onUndoRetorno,
}: TecnicoCardProps) {
  const pctClamped = Math.min(pct, 1);

  return (
    <div
      className={`relative rounded-2xl border p-5 flex flex-col justify-between transition-all ${
        pct >= 1
          ? 'border-emerald-500/50 bg-emerald-500/10'
          : pct >= 0.8
          ? 'border-yellow-500/40 bg-yellow-500/5'
          : pct >= 0.5
          ? 'border-orange-500/30 bg-orange-500/5'
          : 'border-red-500/30 bg-red-500/5'
      }`}
    >
      {/* Posição + Emoji */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-4xl">{getEmoji(pct)}</span>
        {rank < 3 && pct > 0 && (
          <span className="text-xs font-bold bg-yellow-500/20 text-yellow-300 px-2 py-1 rounded-full">
            TOP {rank + 1}
          </span>
        )}
      </div>

      {/* Nome */}
      <h2 className="text-xl font-bold tracking-tight mb-1">{nome}</h2>

      {/* Percentual */}
      <p className={`text-4xl font-black ${getTextColor(pct)}`}>
        {(pct * 100).toFixed(0)}%
      </p>

      {/* Barra de progresso */}
      <div className="mt-3 h-3 bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${getBarColor(pct)}`}
          style={{ width: `${pctClamped * 100}%` }}
        />
      </div>

      {/* OS list */}
      <div className="mt-2 max-h-28 overflow-y-auto space-y-0.5 scrollbar-thin">
        {osList.map((os, idx) => (
          <div
            key={idx}
            className={`flex items-center justify-between text-xs group ${
              os.isRetorno ? 'text-white/30' : 'text-white/50'
            }`}
          >
            <span className={os.isRetorno ? 'line-through' : ''}>
              OS {os.codigo}
            </span>
            <div className="flex items-center gap-1">
              {os.isRetorno ? (
                <>
                  <span className="text-orange-400/60 italic text-[10px]">retorno</span>
                  {isLoggedIn && onUndoRetorno && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onUndoRetorno(os.codigo);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-white/10 transition-all"
                      title="Desfazer retorno"
                    >
                      <Undo2 className="h-3 w-3 text-white/40" />
                    </button>
                  )}
                </>
              ) : (
                <>
                  {os.retornoFrom && (
                    <span className="text-emerald-400/60 italic text-[10px] mr-1">
                      ← {os.retornoFrom}
                    </span>
                  )}
                  <span>{formatBRL(os.valor)}</span>
                  {isLoggedIn && onMarkRetorno && !os.retornoFrom && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onMarkRetorno(os.codigo, os.valor);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-white/10 transition-all"
                      title="Marcar como retorno"
                    >
                      <RotateCcw className="h-3 w-3 text-orange-400/60" />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
        {osList.length === 0 && (
          <p className="text-xs text-white/30 italic">Sem OS no período</p>
        )}
      </div>

      {/* Meta */}
      <p className="text-sm font-semibold text-white/70 mt-2">
        {formatBRL(realizado)}
      </p>
      <p className="text-xs text-white/40">
        Meta: {formatBRL(meta)} • {osList.filter((o) => !o.isRetorno).length} OS
      </p>
    </div>
  );
}
