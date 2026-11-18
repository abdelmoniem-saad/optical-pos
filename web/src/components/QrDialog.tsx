import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { useI18n } from '../i18n/LanguageContext'
import { IS_LOCAL, hasCloudUrl } from '../lib/config'

/**
 * Modal showing a QR code that deep-links a phone to the mobile upload page
 * for one invoice (`/m-upload?inv=...`).
 */
export function QrDialog({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const { t } = useI18n()
  const [qr, setQr] = useState('')

  useEffect(() => {
    QRCode.toDataURL(url, { width: 320, margin: 1 })
      .then(setQr)
      .catch(() => setQr(''))
  }, [url])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-xs rounded-2xl bg-white p-5 text-center shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 font-semibold text-brand-dark">{title}</div>
        {IS_LOCAL && !hasCloudUrl() && (
          <p className="mb-3 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning">
            {t('This register build has no cloud address (VITE_CLOUD_URL), so phones cannot open this code. Attach the photo on this computer instead.')}
          </p>
        )}
        {qr ? (
          <img src={qr} alt="QR" className="mx-auto rounded-lg border border-line" />
        ) : (
          <div className="p-10 text-sm text-muted">{t('Loading…')}</div>
        )}
        <div dir="ltr" className="mt-2 break-all text-xs text-faint">
          {url}
        </div>
        <p className="mt-2 text-xs text-muted">
          {t('Scan this with the phone camera to attach the two photos')}
        </p>
        <button
          onClick={onClose}
          className="mt-3 w-full rounded-lg border border-line py-2 text-sm text-muted hover:bg-surface"
        >
          {t('Close')}
        </button>
      </div>
    </div>
  )
}
