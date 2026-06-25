import { usePOS } from '../POSContext'
import type { Category } from '../types'

const categories: { label: string; value: Category; color: string }[] = [
  { label: 'Glasses', value: 'Frame', color: '#1976d2' },
  { label: 'Sunglasses', value: 'Sunglasses', color: '#388e3c' },
  { label: 'Contact Lenses', value: 'ContactLens', color: '#0288d1' },
  { label: 'Accessories', value: 'Accessory', color: '#f57c00' },
  { label: 'Others', value: 'Other', color: '#7b1fa2' },
]

export function CategoryStep() {
  const { selectCategory } = usePOS()
  return (
    <div className="mx-auto max-w-4xl p-6 text-center">
      <h2 className="mb-6 text-2xl font-bold text-brand-dark">Select Product Category</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {categories.map((c) => (
          <button
            key={c.value}
            onClick={() => selectCategory(c.value)}
            style={{ backgroundColor: c.color }}
            className="flex h-40 flex-col items-center justify-center rounded-2xl p-6 font-bold text-white shadow-sm transition hover:scale-[1.03] hover:shadow-md"
          >
            <span className="text-lg">{c.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
