import { usePermissions } from '../data/permissions'
import { useRegisterStatus, useRevokeRegister } from '../data/register'
import { useStoreId } from '../lib/licensing'
import { useI18n } from '../i18n/LanguageContext'
import { useConfirm, useToast } from './Feedback'

/**
 * Shown on every screen while the store records on its register PC (033:
 * my_permissions().read_only). Renders nothing otherwise, so a shop without a
 * register sees exactly what it saw before.
 *
 * The owner also gets the PC's last sync time (owner decision 12) and the
 * Revoke register lever (design 2.8). Revoke is owner-only in SQL as well:
 * the button is a convenience, never the check.
 */
export function ReadOnlyBanner() {
  const { t, lang } = useI18n()
  const perms = usePermissions()
  const owner = perms.readOnly && perms.isOwner
  const status = useRegisterStatus(perms.readOnly)
  const storeId = useStoreId()
  const revoke = useRevokeRegister()
  const confirm = useConfirm()
  const notify = useToast()

  if (!perms.readOnly) return null

  const fresh = status.data ?? null
  const when = fresh?.lastSyncAt
    ? new Date(fresh.lastSyncAt).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-GB')
    : null

  async function onRevoke() {
    const store = storeId.data
    if (!store || revoke.isPending) return
    const ok = await confirm(
      t('Revoke the register? The shop PC stops syncing until it is set up again. Use this only if the PC is lost or stolen.'),
      { danger: true, confirmLabel: t('Revoke register') },
    )
    if (!ok) return
    try {
      await revoke.mutateAsync({ storeId: store })
      notify(t('Register revoked.'), 'success')
    } catch (e) {
      notify(e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
    }
  }

  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-brand-bg px-4 py-2 text-xs text-brand-dark">
      <span className="font-semibold">{t('Read-only: the shop PC is the system of record')}</span>
      {fresh && (
        <span className="text-muted">
          {when ? `${t('Last sync')}: ${when}` : t('The shop PC has not synced yet')}
          {fresh.pending !== null && ` · ${t('Waiting on the PC')}: ${fresh.pending}`}
        </span>
      )}
      {owner && (
        <button
          type="button"
          onClick={() => void onRevoke()}
          disabled={revoke.isPending || !storeId.data}
          className="ms-auto rounded-lg border border-danger/40 px-3 py-1 text-xs font-semibold text-danger hover:bg-danger-bg disabled:opacity-50"
        >
          {t('Revoke register')}
        </button>
      )}
    </div>
  )
}
