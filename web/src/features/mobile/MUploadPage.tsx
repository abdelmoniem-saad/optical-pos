import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'
import { useI18n } from '../../i18n/LanguageContext'
import { useIsAdmin } from '../../data/staff'
import { useSetOrderImage } from '../../data/sales'
import { prescriptionImageUrl, uploadOrderImage } from '../../lib/storage'
import type { Sale } from '../../lib/database.types'

/**
 * Mobile upload page: open it on the phone (or scan the QR shown on the
 * desktop after checkout / in History) and take the two photos for one
 * invoice directly with the camera.
 *
 * Standalone route: no sidebar; asks for a staff login once per phone (the
 * session persists in the mobile browser afterwards).
 */
export function MUploadPage() {
  const { t } = useI18n()
  const { session } = useAuth()
  const [params] = useSearchParams()
  const [invInput, setInvInput] = useState(params.get('inv') ?? '')
  const [inv, setInv] = useState((params.get('inv') ?? '').trim())
  const isAdmin = useIsAdmin()
  const setImg = useSetOrderImage()
  const qc = useQueryClient()

  const saleQ = useQuery({
    queryKey: ['m-order', inv],
    enabled: !!session && inv.length >= 3,
    queryFn: async (): Promise<Sale | null> => {
      const { data, error } = await supabase
        .from('sales')
        .select('id, invoice_no, rx_image_path, frame_image_path, order_date')
        .eq('invoice_no', inv)
        .maybeSingle<Sale>()
      if (error) throw error
      return data
    },
  })

  const sale = saleQ.data ?? null
  const [busySlot, setBusySlot] = useState<'rx' | 'frame' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Photos uploaded BEFORE checkout (invoice not in the DB yet) live only in
  // storage under the invoice number; checkout adopts them.
  const [uploaded, setUploaded] = useState<Partial<Record<'rx' | 'frame', string>>>({})

  async function handleFile(slot: 'rx' | 'frame', file: File | undefined) {
    if (!file) return
    setBusySlot(slot)
    setErr(null)
    try {
      const path = await uploadOrderImage(file, inv, slot)
      setUploaded((prev) => ({ ...prev, [slot]: path }))
      // Confirmed order? Link directly. Otherwise checkout adopts the file.
      if (sale) {
        await setImg.mutateAsync({ saleId: sale.id, slot, path })
        await qc.invalidateQueries({ queryKey: ['m-order', inv] })
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusySlot(null)
    }
  }

  if (!session) {
    return <MobileLogin />
  }

  return (
    <div dir="rtl" className="min-h-full bg-surface pb-10">
      <header className="border-b border-line/40 bg-white px-4 py-3 text-center font-bold text-brand-dark">
        LensyPOS · {t('Mobile upload')}
      </header>
      <div className="mx-auto max-w-md p-4">
        <label className="mb-1 block text-sm text-muted">{t('Enter invoice number')}</label>
        <div className="mb-4 flex gap-2">
          <input
            dir="ltr"
            value={invInput}
            onChange={(e) => setInvInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setInv(invInput.trim())}
            className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-center text-lg outline-none focus:border-brand"
          />
          <button
            onClick={() => setInv(invInput.trim())}
            className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white"
          >
            {t('Search')}
          </button>
        </div>

        {saleQ.isFetching && <p className="text-sm text-muted">{t('Loading…')}</p>}
        {saleQ.isError && (
          <div className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
            {String(saleQ.error)}
          </div>
        )}
        {inv.length >= 3 && !saleQ.isFetching && !sale && (
          <p className="text-sm text-faint">{t('Invoice not found')}</p>
        )}

        {sale && (
          <div className="rounded-xl border border-line bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="rcpt-num font-semibold text-brand-dark">#{sale.invoice_no}</span>
              <span className="text-xs text-faint">{(sale.order_date ?? '').slice(0, 10)}</span>
            </div>

            {err && (
              <div className="mb-3 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">{err}</div>
            )}

            {(['rx', 'frame'] as const).map((slot) => {
              const dbPath = slot === 'rx' ? sale?.rx_image_path : sale?.frame_image_path
              const path = dbPath ?? uploaded[slot]
              const label = slot === 'rx' ? t('Rx paper photo') : t('Frame photo')
              const isBusy = busySlot === slot
              const canReplace = isAdmin || !dbPath
              return (
                <div key={slot} className="mb-4">
                  <div className="mb-1 text-sm font-semibold text-brand-dark">{label}</div>
                  {path ? (
                    <div className="flex items-center gap-3">
                      <a href={prescriptionImageUrl(path)} target="_blank" rel="noreferrer">
                        <img
                          src={prescriptionImageUrl(path)}
                          alt={label}
                          className="h-20 w-20 rounded-lg border border-line object-cover"
                        />
                      </a>
                      {canReplace ? (
                        <label className="cursor-pointer text-sm text-brand hover:underline">
                          {t('Replace')}
                          <input
                            type="file"
                            accept="image/*"
                            capture="environment"
                            className="hidden"
                            onChange={(e) => handleFile(slot, e.target.files?.[0])}
                          />
                        </label>
                      ) : (
                        <span className="text-xs text-faint">{t('Replace requires admin')}</span>
                      )}
                    </div>
                  ) : (
                    <label className="block cursor-pointer rounded-xl border border-dashed border-line p-4 text-center text-sm text-muted hover:bg-brand-bg/40">
                      📷 {t('Take photo')}
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={(e) => handleFile(slot, e.target.files?.[0])}
                      />
                    </label>
                  )}
                  {isBusy && <p className="mt-1 text-xs text-muted">{t('Uploading…')}</p>}
                </div>
              )
            })}

            {!sale && inv.length >= 3 && !saleQ.isFetching && (
              <p className="rounded-lg bg-brand-bg px-3 py-2 text-xs text-brand-dark">
                {t(
                  'Invoice not found in the system. Photos will attach when the order is confirmed.',
                )}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Compact login shown once per phone until the session sticks. */
function MobileLogin() {
  const { t } = useI18n()
  const { signIn } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const cls = 'w-full rounded-lg border border-line px-3 py-2.5 outline-none focus:border-brand'

  return (
    <div dir="rtl" className="flex min-h-full flex-col items-center justify-center bg-surface p-6">
      <div className="w-full max-w-xs rounded-2xl bg-white p-5 text-center shadow-sm">
        <div className="mb-3 font-bold text-brand-dark">LensyPOS</div>
        <p className="mb-3 text-sm text-muted">{t('Sign in to upload')}</p>
        <div className="space-y-2 text-start">
          <input
            className={cls}
            placeholder={t('Username')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className={cls}
            type="password"
            placeholder={t('Password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {err && <div className="mt-2 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">{t(err)}</div>}
        <button
          onClick={async () => {
            setErr(null)
            setBusy(true)
            try {
              await signIn(username.trim(), password)
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e))
            } finally {
              setBusy(false)
            }
          }}
          disabled={busy || !username.trim() || !password}
          className="mt-3 w-full rounded-lg bg-brand py-2.5 font-semibold text-white disabled:opacity-60"
        >
          {busy ? t('Signing in…') : t('Sign in')}
        </button>
      </div>
    </div>
  )
}
