import * as D from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './button'

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-in" />
        <D.Content
          className={cn(
            'fixed z-50 flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl',
            'bottom-2 left-1/2 -translate-x-1/2 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2',
            {
              sm: 'sm:max-w-md',
              md: 'sm:max-w-xl',
              lg: 'sm:max-w-3xl',
              xl: 'sm:max-w-5xl',
              full: 'sm:max-w-[min(96vw,1400px)]',
            }[size],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <D.Title className="text-base font-semibold">{title}</D.Title>
              {description ? (
                <D.Description className="mt-0.5 text-sm text-muted">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">Dialog</D.Description>
              )}
            </div>
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-surface-2/50 px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** Promise-free confirm dialog with optional required reason input */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  loading,
  requireReason,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  message: ReactNode
  confirmLabel?: string
  danger?: boolean
  loading?: boolean
  requireReason?: string
  onConfirm: (reason?: string) => void
}) {
  const [reason, setReason] = useState('')
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setReason('')
        onOpenChange(o)
      }}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={loading}
            disabled={!!requireReason && reason.trim().length < 3}
            onClick={() => onConfirm(reason.trim() || undefined)}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-muted">{message}</div>
      {requireReason && (
        <div className="mt-4">
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted" htmlFor="confirm-reason">
            {requireReason}
          </label>
          <textarea
            id="confirm-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </div>
      )}
    </Dialog>
  )
}
