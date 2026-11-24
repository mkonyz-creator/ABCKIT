import { Eraser } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Button } from './ui/button'

/** Touch/mouse signature capture → PNG data URL */
export function SignaturePad({ value, onChange, disabled }: { value: string | null; onChange: (v: string | null) => void; disabled?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const dirty = useRef(false)

  useEffect(() => {
    const c = canvas.current!
    const ratio = window.devicePixelRatio || 1
    const rect = c.getBoundingClientRect()
    c.width = rect.width * ratio
    c.height = rect.height * ratio
    const ctx = c.getContext('2d')!
    ctx.scale(ratio, ratio)
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#000'
    if (value) {
      const img = new Image()
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height)
      img.src = value
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pos = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const start = (e: React.PointerEvent) => {
    if (disabled) return
    canvas.current!.setPointerCapture(e.pointerId)
    drawing.current = true
    const ctx = canvas.current!.getContext('2d')!
    const p = pos(e)
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
  }
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return
    const ctx = canvas.current!.getContext('2d')!
    const p = pos(e)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    dirty.current = true
  }
  const end = () => {
    if (!drawing.current) return
    drawing.current = false
    if (dirty.current) onChange(canvas.current!.toDataURL('image/png'))
  }
  const clear = () => {
    const c = canvas.current!
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height)
    dirty.current = false
    onChange(null)
  }

  return (
    <div>
      <div className="relative overflow-hidden rounded-lg border border-dashed border-border-strong bg-white">
        <canvas
          ref={canvas}
          className="block h-36 w-full touch-none"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          aria-label="Signature pad: draw your signature"
          role="img"
        />
        {!value && <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-400">Sign here</span>}
        <span className="pointer-events-none absolute bottom-6 left-6 right-6 border-b border-neutral-300" />
      </div>
      {!disabled && (
        <Button size="sm" variant="ghost" className="mt-1" onClick={clear}>
          <Eraser /> Clear signature
        </Button>
      )}
    </div>
  )
}
