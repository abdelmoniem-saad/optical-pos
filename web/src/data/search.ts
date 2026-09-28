import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { isMissingRpc } from './rpc'
import type { Customer, Product, Sale } from '../lib/database.types'

export type SearchResults = {
  customers: Customer[]
  products: Product[]
  sales: Sale[]
}

/** What search_text() returns: a uniform row per hit, tagged by kind. */
type SearchRow = { kind: string; id: string; label: string; detail: string | null }

function splitRows(rows: SearchRow[], hydrate: {
  customers?: Customer[]
  products?: Product[]
  sales?: Sale[]
}): SearchResults {
  return {
    customers: rows.filter((r) => r.kind === 'customer').map((r) => hydrate.customers?.find((c) => c.id === r.id)).filter(Boolean) as Customer[],
    products: rows.filter((r) => r.kind === 'product').map((r) => hydrate.products?.find((p) => p.id === r.id)).filter(Boolean) as Product[],
    sales: rows.filter((r) => r.kind === 'sale').map((r) => hydrate.sales?.find((s) => s.id === r.id)).filter(Boolean) as Sale[],
  }
}

/**
 * Cross-entity search (customers, products, invoices) - the "giga search"
 * from the top bar. Runs once the term is >= 2 chars.
 *
 * The term is passed to the database as an ARGUMENT (migration 016). It used
 * to be pasted into a PostgREST `or(name.ilike.%term%,...)` string, which
 * cannot be escaped safely - so `,()` were stripped first, and a customer
 * called "Ahmed (Cairo)" simply could not be found, with no error shown. The
 * sanitiser is gone: there is no string to escape, and the trigram index the
 * function uses also stops every keystroke from being a sequential scan.
 *
 * Falls back to the old client path while 016 is unapplied.
 */
export function useGlobalSearch(term: string) {
  const q = term.trim()
  return useQuery({
    queryKey: ['global-search', q],
    enabled: q.length >= 2,
    queryFn: async (): Promise<SearchResults> => {
      const { data, error } = await supabase.rpc('search_text', { p_term: q, p_limit: 18 })
      if (!error) {
        const rows = (data ?? []) as SearchRow[]
        if (rows.length === 0) return { customers: [], products: [], sales: [] }
        // The RPC returns just enough to render a result row; the screens that
        // link onward need the full records, so those are fetched by id.
        const ids = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.id)
        const [c, p, s] = await Promise.all([
          supabase.from('customers').select('*').in('id', ids('customer')).returns<Customer[]>(),
          supabase.from('inventory').select('*').in('id', ids('product')).returns<Product[]>(),
          supabase.from('sales').select('*').in('id', ids('sale')).returns<Sale[]>(),
        ])
        return splitRows(rows, { customers: c.data ?? [], products: p.data ?? [], sales: s.data ?? [] })
      }
      if (!isMissingRpc('search_text', error)) throw error
      // 016 not applied yet: the legacy path, still with the old sanitiser.
      const legacy = q.replace(/[,()]/g, ' ')
      const [c, p, s] = await Promise.all([
        supabase.from('customers').select('*').or(`name.ilike.%${legacy}%,phone.ilike.%${legacy}%`).limit(6).returns<Customer[]>(),
        supabase.from('inventory').select('*').or(`name.ilike.%${legacy}%,sku.ilike.%${legacy}%`).limit(6).returns<Product[]>(),
        supabase.from('sales').select('*').ilike('invoice_no', `%${legacy}%`).limit(6).returns<Sale[]>(),
      ])
      return { customers: c.data ?? [], products: p.data ?? [], sales: s.data ?? [] }
    },
  })
}
