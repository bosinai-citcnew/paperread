import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icons';

export type MenuItem =
  | { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; hidden?: boolean }
  | 'sep'
  | { title: string };

interface Props {
  items: MenuItem[];
  label?: string;
  icon?: string;
  small?: boolean;
  className?: string;
  /** custom trigger content; defaults to a ⋯ icon button */
  children?: ReactNode;
}

/** Shared overflow menu. Renders in a portal so it is never clipped or transformed by scrollers / dnd. */
export default function Menu({ items, label = '更多', icon = 'more', small, className, children }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current || !pop.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = pop.current.offsetWidth, h = pop.current.offsetHeight;
    let left = r.right - w;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    setPos({ top, left });
  }, [open]);

  const visible = items.filter(i => i === 'sep' || 'title' in i || !i.hidden);
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  return (
    <>
      <button ref={btn} type="button" className={children ? (className ?? 'btn') : 'icon-btn' + (small ? ' sm' : '')} aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={e => { e.stopPropagation(); setPos(null); setOpen(o => !o); }} onPointerDown={stop} onKeyDown={stop}>
        {children ?? <Icon name={icon} size={small ? 20 : 22} />}
      </button>
      {open && createPortal(
        <div onClick={stop} onPointerDown={stop}>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div ref={pop} className="menu" role="menu" style={{ top: pos?.top ?? -999, left: pos?.left ?? -999, visibility: pos ? 'visible' : 'hidden' }}>
            {visible.map((it, i) => it === 'sep' ? <div key={i} className="menu-sep" /> : 'title' in it ? <div key={i} className="menu-title">{it.title}</div> : (
              <button key={i} type="button" role="menuitem" className={'menu-item' + (it.danger ? ' danger' : '')} disabled={it.disabled}
                onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
