import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

/**
 * A dialog that behaves the way people expect one to: a close button, Escape
 * closes it, clicking the backdrop closes it, focus moves inside on open and
 * returns where it came from on close, and the page behind cannot scroll.
 */
export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Tailwind max-width class. */
  width?: string;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-lg',
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;

    returnFocusTo.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      // Keep Tab inside the dialog while it is open.
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    // Focus the first useful control rather than the close button.
    const timer = window.setTimeout(() => {
      const target = panelRef.current?.querySelector<HTMLElement>(
        'input:not([type=hidden]), textarea, select, [data-autofocus]',
      );
      (target ?? panelRef.current)?.focus();
    }, 0);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      (returnFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[10vh] animate-fade-in"
      onMouseDown={(event) => {
        // Only a press that both starts and ends on the backdrop closes it, so
        // a text selection dragged out of the dialog does not dismiss it.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`card w-full ${width} animate-scale-in bg-raised shadow-overlay outline-none`}
      >
        <header className="flex items-start gap-4 border-b border-line px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold tracking-tight">{title}</h2>
            {description && <p className="mt-0.5 text-xs leading-snug text-muted">{description}</p>}
          </div>
          <button className="btn-icon -mr-1.5 -mt-0.5" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="px-5 py-4">{children}</div>

        {footer && (
          <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
