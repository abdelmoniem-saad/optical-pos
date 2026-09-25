import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { useI18n } from '../i18n/LanguageContext'

// Co-locating the provider with its hooks (same pattern as auth/POSContext).
/* eslint-disable react-refresh/only-export-components */

type Kind = 'error' | 'info' | 'success'

type ConfirmOptions = { danger?: boolean; confirmLabel?: string }

type Toast = { message: string; kind: Kind }

type FeedbackApi = {
  /** In-app replacement for window.confirm: translated, styled, and immune to
   *  the native dialogs that standalone PWAs may suppress. */
  confirm: (message: string, opts?: ConfirmOptions) => Promise<boolean>
  /** In-app replacement for alert(). */
  notify: (message: string, kind?: Kind) => void
}

type Pending = {
  message: string
  danger: boolean
  confirmLabel: string
  resolve: (ok: boolean) => void
}

const Ctx = createContext<FeedbackApi | undefined>(undefined)

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const [pending, setPending] = useState<Pending | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)

  const confirm = useCallback((message: string, opts?: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending({
        message,
        danger: opts?.danger ?? true,
        confirmLabel: opts?.confirmLabel ?? 'Continue',
        resolve,
      })
    })
  }, [])

  const notify = useCallback((message: string, kind: Kind = 'error') => {
    setToast({ message, kind })
  }, [])

  // Toasts dismiss themselves; a confirm dialog waits for an answer.
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(id)
  }, [toast])

  function answer(ok: boolean) {
    if (pending) pending.resolve(ok)
    setPending(null)
  }

  return (
    <Ctx.Provider value={{ confirm, notify }}>
      {children}

      {pending && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
          onClick={() => answer(false)}
        >
          <div
            role="dialog"
            className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-5 whitespace-pre-wrap break-words text-sm text-brand-dark">
              {pending.message}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => answer(false)}
                className="rounded-lg border border-line px-4 py-2 text-sm text-muted hover:bg-surface"
              >
                {t('Cancel')}
              </button>
              <button
                autoFocus
                onClick={() => answer(true)}
                className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${
                  pending.danger ? 'bg-danger' : 'bg-brand'
                }`}
              >
                {t(pending.confirmLabel)}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-20 end-4 z-[75] max-w-sm rounded-xl border border-line bg-white px-4 py-3 text-sm shadow-xl sm:bottom-6">
          <div className="flex items-start gap-3">
            <span
              className={
                toast.kind === 'error'
                  ? 'text-danger'
                  : toast.kind === 'success'
                    ? 'text-success'
                    : 'text-brand'
              }
            >
              {toast.kind === 'error' ? '⚠' : toast.kind === 'success' ? '✓' : 'ℹ'}
            </span>
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{toast.message}</p>
            <button
              onClick={() => setToast(null)}
              className="text-faint hover:text-muted"
              title={t('Close')}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </Ctx.Provider>
  )
}

export function useConfirm(): FeedbackApi['confirm'] {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useConfirm must be used within <FeedbackProvider>')
  return ctx.confirm
}

export function useToast(): FeedbackApi['notify'] {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useToast must be used within <FeedbackProvider>')
  return ctx.notify
}
