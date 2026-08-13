import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from './Icon';

/**
 * Brief confirmations and errors.
 *
 * Ingestion, mapping and note edits all happen without changing the page, so
 * without this there is no evidence anything worked. Errors stay until
 * dismissed; successes clear themselves.
 */
export type ToastTone = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  detail?: string;
}

interface ToastApi {
  show: (message: string, options?: { tone?: ToastTone; detail?: string; ms?: number }) => void;
  success: (message: string, detail?: string) => void;
  error: (message: string, detail?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}

const TONE: Record<ToastTone, { icon: IconName; className: string }> = {
  success: { icon: 'check', className: 'border-accent/30 bg-accent-soft text-accent' },
  error: { icon: 'alert', className: 'border-flag/30 bg-flag-soft text-flag' },
  info: { icon: 'info', className: 'border-line bg-raised text-ink' },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback<ToastApi['show']>(
    (message, options = {}) => {
      const id = nextId.current++;
      const tone = options.tone ?? 'info';
      setToasts((current) => [...current, { id, tone, message, detail: options.detail }]);

      // Errors are worth reading properly, so they wait to be dismissed.
      const ms = options.ms ?? (tone === 'error' ? 0 : 3500);
      if (ms > 0) window.setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message, detail) => show(message, { tone: 'success', ...(detail ? { detail } : {}) }),
      error: (message, detail) => show(message, { tone: 'error', ...(detail ? { detail } : {}) }),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3 py-2.5 shadow-raised animate-slide-in ${TONE[toast.tone].className}`}
          >
            <Icon name={TONE[toast.tone].icon} size={16} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-snug">{toast.message}</p>
              {toast.detail && (
                <p className="mt-0.5 break-words text-xs leading-snug opacity-80">{toast.detail}</p>
              )}
            </div>
            <button
              onClick={() => dismiss(toast.id)}
              className="-mr-1 -mt-0.5 rounded p-1 opacity-60 transition hover:opacity-100"
              aria-label="Dismiss"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
