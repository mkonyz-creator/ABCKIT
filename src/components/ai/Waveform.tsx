/**
 * Voice waveform: real levels from a level meter (live voice: microphone or the assistant's voice), or a gentle
 * animation when only the state is known (browser voice). Respects prefers-reduced-motion.
 */
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

export function Waveform({ levels, active, tone = 'accent', className }: { levels?: (() => number[]) | null; active: boolean; tone?: 'accent' | 'danger' | 'muted'; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const g = el.getContext('2d')
    if (!g) return
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const color = getComputedStyle(el).color
    let raf = 0
    let t = 0
    const draw = () => {
      const w = (el.width = el.clientWidth * devicePixelRatio)
      const h = (el.height = el.clientHeight * devicePixelRatio)
      g.clearRect(0, 0, w, h)
      g.fillStyle = color
      const n = 24
      const live = levels?.()
      const bw = w / (n * 1.6)
      for (let i = 0; i < n; i++) {
        let v: number
        if (live?.length) v = live[i % live.length]
        else if (active && !reduce) v = 0.25 + 0.35 * Math.abs(Math.sin(t / 9 + i * 0.7)) * Math.abs(Math.cos(t / 13 + i * 0.3))
        else v = 0.06
        const bh = Math.max(2 * devicePixelRatio, v * h)
        const x = i * bw * 1.6 + bw * 0.3
        g.globalAlpha = active ? 0.9 : 0.35
        g.fillRect(x, (h - bh) / 2, bw, bh)
      }
      t++
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [levels, active])
  return <canvas ref={canvas} aria-hidden className={cn('h-8 w-full', tone === 'danger' ? 'text-danger' : tone === 'muted' ? 'text-subtle' : 'text-accent', className)} />
}
