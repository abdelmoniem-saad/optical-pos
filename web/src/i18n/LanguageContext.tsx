import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { ar, type Lang } from './translations'

const STORAGE_KEY = 'lensy-lang'

type I18n = {
  lang: Lang
  dir: 'rtl' | 'ltr'
  setLang: (l: Lang) => void
  toggle: () => void
  t: (key: string) => string
}

const Ctx = createContext<I18n | undefined>(undefined)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved === 'en' || saved === 'ar' ? saved : 'ar' // Arabic by default
  })

  useEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
    localStorage.setItem(STORAGE_KEY, lang)
  }, [lang])

  const setLang = useCallback((l: Lang) => setLangState(l), [])
  const toggle = useCallback(() => setLangState((l) => (l === 'ar' ? 'en' : 'ar')), [])
  const t = useCallback(
    (key: string) => (lang === 'ar' ? (ar[key] ?? key) : key),
    [lang],
  )

  return (
    <Ctx.Provider value={{ lang, dir: lang === 'ar' ? 'rtl' : 'ltr', setLang, toggle, t }}>
      {children}
    </Ctx.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useI18n(): I18n {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useI18n must be used within <LanguageProvider>')
  return ctx
}
