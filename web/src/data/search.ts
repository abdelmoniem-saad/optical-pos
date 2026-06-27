import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import type { Customer, Product, Sale } from '../lib/database.types'

export type SearchResults = {
  customers: Customer[]
  products: Product[]
  sales: Sale[]
}

/** Cross-entity search (customers, products, invoices) — the "giga search"
 *  from the Flet top bar. Runs once the term is >= 2 chars. */
export function useGlobalSearch(term: string) {
  const q = term.trim().replace(/[,()]/g, ' ')
  return useQuery({
    queryKey: ['global-search', q],
    enabled: q.length >= 2,
    queryFn: async (): Promise<SearchResults> => {
      const [c, p, s] = await Promise.all([
        supabase
          .from('customers')
          .select('*')
          .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
          .limit(6)
          .returns<Customer[]>(),
        supabase
          .from('inventory')
          .select('*')
          .or(`name.ilike.%${q}%,sku.ilike.%${q}%`)
          .limit(6)
          .returns<Product[]>(),
        supabase
          .from('sales')
          .select('*')
          .ilike('invoice_no', `%${q}%`)
          .limit(6)
          .returns<Sale[]>(),
      ])
      return { customers: c.data ?? [], products: p.data ?? [], sales: s.data ?? [] }
    },
  })
}
