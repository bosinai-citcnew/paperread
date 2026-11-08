import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icons';

interface Props {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** extra element in the header (e.g. a ⋯ menu) */
  headerRight?: ReactNode;
  label?: string;
}

/** Shared bottom sheet (centered dialog on desktop). Closes on backdrop click and Escape. */
export default function Sheet({ open, onClose, title, children, footer, wide, headerRight, label }: Props) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="sheet-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={'sheet' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={label ?? (typeof title === 'string' ? title : undefined)}>
        <div className="sheet-grab" />
        <div className="sheet-head">
          <h2 className="sheet-title">{title}</h2>
          {headerRight}
          <button type="button" className="icon-btn sm" aria-label="關閉" onClick={onClose}><Icon name="close" size={20} /></button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
