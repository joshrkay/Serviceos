import { Sparkles, RotateCcw } from 'lucide-react';

export function DemoCard({
  tag, tagColor = 'bg-indigo-100 text-indigo-700',
  title, children, onReset,
}: {
  tag: string; tagColor?: string; title?: string;
  children: React.ReactNode; onReset?: () => void;
}) {
  return (
    <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs ${tagColor}`}>{tag}</span>
          {title && <span className="text-xs text-slate-500">{title}</span>}
        </div>
        {onReset && (
          <button
            onClick={onReset}
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 transition-colors"
          >
            <RotateCcw size={10} /> Reset
          </button>
        )}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

export function AILabel({ text = '✦ Fieldly AI' }: { text?: string }) {
  return (
    <p className="flex items-center gap-1 text-xs text-indigo-600 mb-1">
      <Sparkles size={10} /> {text}
    </p>
  );
}

export function ConfBar({ level }: { level: 'high' | 'medium' | 'low' }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-20 h-1.5 rounded-full overflow-hidden bg-slate-100">
        <div className={`h-full rounded-full transition-all ${
          level === 'high' ? 'w-full bg-green-500' :
          level === 'medium' ? 'w-3/5 bg-amber-400' : 'w-1/4 bg-red-400'
        }`} />
      </div>
      <span className={`text-xs ${
        level === 'high' ? 'text-green-700' :
        level === 'medium' ? 'text-amber-700' : 'text-red-600'
      }`}>
        {level === 'high' ? 'High confidence' : level === 'medium' ? 'Review recommended' : 'Ambiguous'}
      </span>
    </div>
  );
}
