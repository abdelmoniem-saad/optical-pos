/* eslint-disable react-refresh/only-export-components */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { callReportRow, fetchStoreDay } from './sales'
import { isMissingRpc, type RpcErrorLike } from './rpc'

/** One row of public.z_report(). Money is net of refunds by construction - a void
 *  writes a compensating negative payment, so it cancels itself in the sum. */
export interface ZReport {
  expectedCash: number
  expectedByTender: Record<string, number>
  expectedTotal: number
  orderCount: number
  prescriptionCount: number
  voidCount: number
  refundTotal: number
  labDelivered: number
}

/** One recorded close, from the append-only shift_closes ledger. */
export interface ShiftClose {
  id: string
  closedAt: string | null
  fromAt: string
  toAt: string
  countedCash: number
  expectedCash: number
  expectedByTender: Record<string, number> | null
  expectedTotal: number
  variance: number
  orderCount: number
  prescriptionCount: number
  voidCount: number
  refundTotal: number
  labDelivered: number
  note: string | null
}

export interface DayBounds {
  from: string
  to: string
}

const num = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(x) ? x : 0
}

const int = (v: unknown): number => Math.trunc(num(v))

/** Postgres jsonb arrives as an object; anything else means "no tenders", which
 *  is a real state (a day with no money) rather than an error. */
function tenderMap(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, number> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = num(val)
  return out
}

/**
 * WHY THIS FILE IS AS Fussy AS IT IS
 * ---------------------------------
 * A Z report that answers "nothing" when it should answer "run the migration"
 * is the worst kind of bug: the screen shows a confident row of zeros, which
 * reads as a fact about the business rather than about the software. That is not
 * hypothetical - it is exactly what happened when a tenant-scoped report was run
 * from the SQL Editor with no JWT, where `auth_store_id()` is NULL and every row
 * matches nothing.
 *
 * So `status: 'missing'` is a first-class outcome here, distinct from
 * `status: 'ready'` with zeros, and the screen is required to say which it is.
 */

/** The 'ready' arm, named so a caller can hold it in a variable. */
export type ZReportReady = Extract<ZReportResult, { status: 'ready' }>

/**
 * Type guard for the 'ready' arm.
 *
 * Exists because `data && data.status === 'ready' ? data : null` does NOT narrow
 * the stored value in TypeScript - the conditional's true branch is re-read, so
 * `live.report` comes back as "property does not exist on ZReportResult". A
 * declared guard narrows properly and says what it means at the call site, which
 * a cast would not.
 */
export function isZReportReady(r: ZReportResult | undefined): r is ZReportReady {
  return !!r && r.status === 'ready'
}

/** 'missing' means migration 023 has not been applied. Never conflate it with
 *  a day that genuinely had no money. */
export type ZReportResult =
  | { status: 'ready'; report: ZReport; bounds: DayBounds }
  | { status: 'missing' }
  | { status: 'no-bounds' }
  | { status: 'error'; message: string }

/** The day's bounds, in the STORE's own timezone. `to` is EXCLUSIVE (the next
 *  local midnight), so the server's `<` comparisons line up. */
export function useStoreDayBounds(day: string | null) {
  return useQuery({
    queryKey: ['store-day', day],
    enabled: !!day,
    queryFn: async (): Promise<DayBounds | null> => {
      const b = await fetchStoreDay(day as string)
      return b
    },
  })
}

/** Live figures for a day. Bounded by store_day_range, never by the browser's
 *  idea of midnight - a tablet with the wrong clock must not move the books. */
export function useZReport(day: string | null) {
  const bounds = useStoreDayBounds(day)
  return useQuery({
    queryKey: ['z-report', day],
    enabled: !!bounds.data,
    queryFn: async (): Promise<ZReportResult> => {
      const b = bounds.data
      if (!b) return { status: 'no-bounds' }
      try {
        // Single-row `returns table` - PostgREST wraps it in an array, which is
        // why this goes through callReportRow and not callReport.
        const row = await callReportRow<Record<string, unknown>>('z_report', () =>
          supabase.rpc('z_report', { p_from: b.from, p_to: b.to }),
        )
        if (!row) {
          // callReportRow swallows a MISSING function (it returns null) and
          // throws on a real error, so null here means "not installed".
          return { status: 'missing' }
        }
        return {
          status: 'ready',
          bounds: b,
          report: {
            expectedCash: num(row.expected_cash),
            expectedByTender: tenderMap(row.expected_by_tender),
            expectedTotal: num(row.expected_total),
            orderCount: int(row.order_count),
            prescriptionCount: int(row.prescription_count),
            voidCount: int(row.void_count),
            refundTotal: num(row.refund_total),
            labDelivered: int(row.lab_delivered),
          },
        }
      } catch (err) {
        if (isMissingRpc('z_report', err as RpcErrorLike)) return { status: 'missing' }
        return { status: 'error', message: (err as Error)?.message ?? 'unknown error' }
      }
    },
  })
}

function mapClose(row: Record<string, unknown>): ShiftClose {
  return {
    id: String(row.id ?? ''),
    closedAt: (row.closed_at as string) ?? null,
    fromAt: String(row.from_at ?? ''),
    toAt: String(row.to_at ?? ''),
    countedCash: num(row.counted_cash),
    expectedCash: num(row.expected_cash),
    expectedByTender: tenderMap(row.expected_by_tender),
    expectedTotal: num(row.expected_total),
    variance: num(row.variance),
    orderCount: int(row.order_count),
    prescriptionCount: int(row.prescription_count),
    voidCount: int(row.void_count),
    refundTotal: num(row.refund_total),
    labDelivered: int(row.lab_delivered),
    note: (row.note as string) ?? null,
  }
}

/** Recent closes, newest first. The ledger is append-only, so this is the only
 *  way to answer "was the drawer right last Tuesday?" - which is the entire
 *  reason the table exists. RLS scopes it to the caller's store. */
export function useShiftCloses(limit = 20) {
  return useQuery({
    queryKey: ['shift-closes', limit],
    queryFn: async (): Promise<ShiftClose[]> => {
      const { data, error } = await supabase
        .from('shift_closes')
        .select('*')
        .order('closed_at', { ascending: false })
        .limit(limit)
      if (error) throw error
      return ((data ?? []) as Record<string, unknown>[]).map(mapClose)
    },
  })
}

/** Record a close. Returns the stored row, whose variance is the AUTHORITY -
 *  the client may preview one, but the server computes the number that is kept. */
export function useCloseShift() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      from: string
      to: string
      countedCash: number
      note?: string | null
    }): Promise<ShiftClose> => {
      // `returns public.shift_closes` is a COMPOSITE, so this arrives as ONE
      // object rather than an array - the opposite of z_report above.
      const { data, error } = await supabase.rpc('close_shift', {
        p_from: input.from,
        p_to: input.to,
        p_counted_cash: input.countedCash,
        p_note: input.note ?? null,
      })
      if (error) throw error
      if (!data) throw new Error('the close returned no row - nothing was recorded')
      return mapClose(data as Record<string, unknown>)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shift-closes'] })
      qc.invalidateQueries({ queryKey: ['z-report'] })
    },
  })
}

// ---- pure helpers, exported so they can be tested without a network ----

/** Parse what the cashier typed into the counted-cash box.
 *
 *  Returns null for anything that is not a finite amount, which the screen
 *  treats as "not filled in yet" rather than as zero. Treating an empty box as
 *  0 would produce a variance of the full expected total and look, on screen,
 *  like a catastrophic shortfall. */
export function parseCountedCash(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  const v = Number(s)
  if (!Number.isFinite(v)) return null
  return Math.round(v * 100) / 100
}

/** Counted MINUS expected, so a shortfall is negative and a surplus positive -
 *  the direction a shop reads without thinking about it. */
export function computeVariance(counted: number | null, expected: number): number | null {
  if (counted === null) return null
  return Math.round((counted - expected) * 100) / 100
}

export type VarianceVerdict = 'balanced' | 'short' | 'over' | 'unknown'

/** A tolerance of a cent: money is stored at 2dp and a rounding artefact is not
 *  a discrepancy worth a paragraph. */
export function varianceVerdict(v: number | null): VarianceVerdict {
  if (v === null) return 'unknown'
  if (Math.abs(v) < 0.005) return 'balanced'
  return v < 0 ? 'short' : 'over'
}
