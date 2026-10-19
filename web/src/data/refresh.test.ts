import { QueryClient } from '@tanstack/react-query'
import { expect, it } from 'vitest'
import { invalidateSales, invalidateAccess } from './refresh'

it('refreshes mounted workflow variants after collection or an invoice change', async () => {
  const qc = new QueryClient()
  const keys = [['sales','paged','all'], ['sales','lab','Ready'], ['sale_payments','invoice'],
    ['customer-balance','customer'], ['customer-debtors','today'], ['lab-queue','Ready'],
    ['report-totals','today'], ['z-report','today'], ['inventory','Frame']]
  for (const key of keys) qc.setQueryData(key, 'old')
  qc.setQueryData(['settings'], 'unrelated')
  await invalidateSales(qc)
  for (const key of keys) expect(qc.getQueryState(key)?.isInvalidated).toBe(true)
  expect(qc.getQueryState(['settings'])?.isInvalidated).toBe(false)
})

it('invalidates authority and staff identity after removing a position', async () => {
  const qc = new QueryClient()
  for (const key of ['my-permissions','current-user','my-store-id','my-license','role_permissions','user_permissions']) qc.setQueryData([key,'user'], {})
  await invalidateAccess(qc)
  expect(qc.getQueryCache().getAll().every(q => q.state.isInvalidated)).toBe(true)
})
