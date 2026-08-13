import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Modal } from './Modal';

/**
 * Ask before doing something that cannot be undone.
 *
 * Deleting a module takes its sections, notes and ingested sources with it, and
 * a browser confirm() is both ugly and easy to dismiss by reflex. This states
 * plainly what is about to be lost.
 */
interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: 'danger' | 'normal';
}

type Resolver = (confirmed: boolean) => void;

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return confirm;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<Resolver | null>(null);

  const confirm = useCallback((next: ConfirmOptions) => {
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (confirmed: boolean) => {
    setOptions(null);
    resolver.current?.(confirmed);
    resolver.current = null;
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={options !== null}
        onClose={() => settle(false)}
        title={options?.title ?? ''}
        width="max-w-md"
        footer={
          <>
            <button className="btn" onClick={() => settle(false)}>
              Cancel
            </button>
            <button
              data-autofocus
              className={`btn ${options?.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
              onClick={() => settle(true)}
            >
              {options?.confirmLabel ?? 'Confirm'}
            </button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-muted">{options?.message}</p>
      </Modal>
    </ConfirmContext.Provider>
  );
}
