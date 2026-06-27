import { useEffect, useState } from 'react'

/** Simple on-screen calculator modal (browsers can't open the OS calculator). */
export function Calculator({ onClose }: { onClose: () => void }) {
  const [display, setDisplay] = useState('0')
  const [prev, setPrev] = useState<number | null>(null)
  const [op, setOp] = useState<string | null>(null)
  const [fresh, setFresh] = useState(true)

  function inputDigit(d: string) {
    setDisplay((cur) => (fresh || cur === '0' ? d : cur + d))
    setFresh(false)
  }
  function inputDot() {
    if (fresh) {
      setDisplay('0.')
      setFresh(false)
    } else if (!display.includes('.')) {
      setDisplay(display + '.')
    }
  }
  function apply(a: number, b: number, o: string): number {
    switch (o) {
      case '+': return a + b
      case '−': return a - b
      case '×': return a * b
      case '÷': return b === 0 ? NaN : a / b
      default: return b
    }
  }
  function chooseOp(o: string) {
    const cur = parseFloat(display)
    if (prev !== null && op && !fresh) {
      const r = apply(prev, cur, op)
      setPrev(r)
      setDisplay(String(r))
    } else {
      setPrev(cur)
    }
    setOp(o)
    setFresh(true)
  }
  function equals() {
    if (prev === null || !op) return
    const r = apply(prev, parseFloat(display), op)
    setDisplay(Number.isNaN(r) ? 'Error' : String(r))
    setPrev(null)
    setOp(null)
    setFresh(true)
  }
  function clear() {
    setDisplay('0')
    setPrev(null)
    setOp(null)
    setFresh(true)
  }
  function backspace() {
    setDisplay((c) => (c.length > 1 ? c.slice(0, -1) : '0'))
  }
  function percent() {
    setDisplay(String(parseFloat(display) / 100))
    setFresh(true)
  }

  function press(k: string) {
    if (k >= '0' && k <= '9') inputDigit(k)
    else if (k === '.') inputDot()
    else if (k === 'C') clear()
    else if (k === '⌫') backspace()
    else if (k === '%') percent()
    else if (k === '=') equals()
    else chooseOp(k)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key >= '0' && e.key <= '9') inputDigit(e.key)
      else if (e.key === '.') inputDot()
      else if (e.key === '+') chooseOp('+')
      else if (e.key === '-') chooseOp('−')
      else if (e.key === '*') chooseOp('×')
      else if (e.key === '/') { e.preventDefault(); chooseOp('÷') }
      else if (e.key === 'Enter' || e.key === '=') equals()
      else if (e.key === 'Escape') onClose()
      else if (e.key === 'Backspace') backspace()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, prev, op, fresh])

  const keys = [
    'C', '⌫', '%', '÷',
    '7', '8', '9', '×',
    '4', '5', '6', '−',
    '1', '2', '3', '+',
    '0', '.', '=',
  ]

  function keyClass(k: string) {
    if (k === '=') return 'bg-brand text-white'
    if ('+−×÷'.includes(k)) return 'bg-brand-bg text-brand-dark'
    if (k === 'C' || k === '⌫' || k === '%') return 'bg-surface text-danger'
    return 'bg-surface'
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-64 rounded-2xl bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        dir="ltr"
      >
        <div className="mb-3 overflow-x-auto rounded-lg bg-surface px-3 py-3 text-end font-mono text-2xl">
          {display}
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {keys.map((k) => (
            <button
              key={k}
              onClick={() => press(k)}
              className={`rounded-lg py-3 text-lg font-semibold hover:opacity-80 ${keyClass(k)} ${
                k === '0' ? 'col-span-2' : ''
              }`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
