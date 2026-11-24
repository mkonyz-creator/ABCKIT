import { cn } from '@/lib/utils'

/** ABCkit toolbox logo (public/logo.svg) in the system colours: orange #FF6B00, black and white. */
export function BrandMark({ className, title = 'ABCkit' }: { className?: string; title?: string }) {
  return <img src={`${import.meta.env.BASE_URL}logo.svg`} alt={title} draggable={false} className={cn('size-10 shrink-0 select-none object-contain', className)} />
}
