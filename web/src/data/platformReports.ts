import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { callReport } from './sales'
import { buildPlatformReport, EMPTY_REPORT, type PlatformReport } from '../lib/platformReportShape'

export type { PlatformReport, PlatformStoreRow } from '../lib/platformReportShape'

/**
 * Consolidated revenue for every store, for one CALENDAR day.
 *
 * The day is a plain 'YYYY-MM-DD' and each store applies it in its OWN timezone
 * - 025's design decision, pinned by the gate's G-A6. The browser's idea of
 * today is only the default: the server re-derives every bound itself, so a
 * tablet with the wrong clock cannot move anybody's books.
 *
 * The refusal is a normal outcome here, not an error. The RPC raises 'platform
 * admin only' for anybody else, and callReport turns a missing function into
 * null, so a shop admin reaching this screen sees "not available" rather than a
 * failed query.
 */
export function usePlatformReport(day: string) {
  return useQuery({
    queryKey: ['platform-report', day],
    staleTime: 60_000,
    queryFn: async (): Promise<PlatformReport> => {
      const data = await callReport<unknown[]>('platform_report_window', () =>
        supabase.rpc('platform_report_window', { p_day: day }),
      )
      // null means the RPC is absent (pre-025). An EMPTY ARRAY is a real answer
      // from a real database and has to stay distinguishable from it.
      if (data === null) return EMPTY_REPORT
      return buildPlatformReport(data)
    },
  })
}
