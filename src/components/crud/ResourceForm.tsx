import { useEffect, useMemo } from 'react'
import { useForm, type RegisterOptions } from 'react-hook-form'
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form'
import { useList } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { useAuth } from '@/providers/AuthProvider'

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'money'
  | 'percent'
  | 'date'
  | 'time'
  | 'email'
  | 'tel'
  | 'select'
  | 'relation'
  | 'checkbox'
  | 'unit'
  | 'currency'

export interface RelationDef {
  table: string
  select?: string
  label: (row: any) => string
  eq?: Record<string, string | number | boolean | null>
  order?: string
  filter?: (row: any) => boolean
}

export interface FieldDef {
  name: string
  label: string
  type: FieldType
  required?: boolean
  min?: number
  max?: number
  step?: number
  maxLength?: number
  options?: Array<{ value: string; label: string }>
  relation?: RelationDef
  span?: 1 | 2
  hint?: string
  placeholder?: string
  defaultValue?: unknown
  hidden?: (values: Record<string, any>, editing: boolean) => boolean
  disabled?: (values: Record<string, any>, editing: boolean) => boolean
}

function RelationSelect({ def, ...props }: { def: FieldDef } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const rel = def.relation!
  const q = useList(rel.table, { select: rel.select ?? '*', eq: rel.eq, order: rel.order ? { column: rel.order } : undefined })
  const rows = (q.data ?? []).filter(rel.filter ?? (() => true))
  return (
    <Select {...props}>
      <option value="">{q.isLoading ? 'Loading…' : def.required ? 'Select…' : '— None —'}</option>
      {rows.map((r: any) => (
        <option key={r.id} value={r.id}>
          {rel.label(r)}
        </option>
      ))}
    </Select>
  )
}

export function toFormValues(fields: FieldDef[], record?: Record<string, any> | null, defaults?: Record<string, any>) {
  const out: Record<string, any> = {}
  for (const f of fields) {
    const v = record?.[f.name] ?? defaults?.[f.name] ?? (typeof f.defaultValue === 'function' ? (f.defaultValue as () => unknown)() : f.defaultValue)
    if (f.type === 'checkbox') out[f.name] = Boolean(v)
    else if (f.type === 'date') out[f.name] = v ? String(v).slice(0, 10) : ''
    else if (f.type === 'time') out[f.name] = v ? String(v).slice(0, 5) : ''
    else out[f.name] = v ?? ''
  }
  return out
}

/** Converts form strings back to typed DB values: '' → null, numerics → Number */
export function fromFormValues(fields: FieldDef[], values: Record<string, any>) {
  const out: Record<string, any> = {}
  for (const f of fields) {
    if (!(f.name in values)) continue
    const v = values[f.name]
    if (f.type === 'checkbox') out[f.name] = Boolean(v)
    else if (['number', 'money', 'percent'].includes(f.type)) out[f.name] = v === '' || v === null ? null : Number(v)
    else out[f.name] = typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v
  }
  return out
}

export function ResourceForm({
  id,
  fields,
  initial,
  editing,
  onSubmit,
}: {
  id: string
  fields: FieldDef[]
  initial: Record<string, any>
  editing: boolean
  onSubmit: (values: Record<string, any>) => void
}) {
  const { settings } = useAuth()
  const form = useForm<Record<string, any>>({ defaultValues: initial, mode: 'onBlur' })
  const { register, handleSubmit, watch, reset, formState } = form
  useEffect(() => reset(initial), [initial, reset])
  const values = watch()

  const units = settings?.units ?? []
  const currencies = useMemo(() => (settings?.currencies ?? [{ code: 'TZS', name: 'TZS', rate: 1 }]).map((c) => c.code), [settings])

  return (
    <form id={id} onSubmit={handleSubmit((v) => onSubmit(fromFormValues(fields, v)))} className="grid grid-cols-1 gap-4 sm:grid-cols-2" noValidate>
      {fields.map((f) => {
        if (f.hidden?.(values, editing)) return null
        const err = formState.errors[f.name]?.message as string | undefined
        const rules: RegisterOptions = {
          required: f.required ? `${f.label} is required` : false,
        }
        if (['number', 'money', 'percent'].includes(f.type)) {
          const min = f.min ?? (f.type === 'number' ? undefined : 0)
          const max = f.max ?? (f.type === 'percent' ? 100 : undefined)
          rules.validate = (v: any) => {
            if (v === '' || v === null || v === undefined) return true
            const n = Number(v)
            if (!Number.isFinite(n)) return 'Enter a valid number'
            if (min !== undefined && n < min) return `Must be at least ${min}`
            if (max !== undefined && n > max) return `Must be at most ${max}`
            return true
          }
        }
        if (f.type === 'email') rules.pattern = { value: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, message: 'Enter a valid email address' }
        if (f.maxLength) rules.maxLength = { value: f.maxLength, message: `Maximum ${f.maxLength} characters` }
        const common = {
          id: `${id}-${f.name}`,
          disabled: f.disabled?.(values, editing),
          'aria-invalid': err ? true : undefined,
          placeholder: f.placeholder,
          ...register(f.name, rules),
        }
        const span = f.span === 2 || f.type === 'textarea' ? 'sm:col-span-2' : ''

        if (f.type === 'checkbox') {
          return (
            <div key={f.name} className={cn('flex items-end pb-2', span)}>
              <Checkbox label={f.label} {...register(f.name)} disabled={common.disabled} />
            </div>
          )
        }

        let control
        switch (f.type) {
          case 'textarea':
            control = <Textarea {...common} rows={3} />
            break
          case 'select':
            control = (
              <Select {...common}>
                <option value="">{f.required ? 'Select…' : '— None —'}</option>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )
            break
          case 'relation':
            control = <RelationSelect def={f} {...common} />
            break
          case 'unit':
            control = (
              <Select {...common}>
                <option value="">Select…</option>
                {units.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            )
            break
          case 'currency':
            control = (
              <Select {...common}>
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )
            break
          case 'number':
          case 'money':
          case 'percent':
            control = <Input {...common} type="number" inputMode="decimal" step={f.step ?? (f.type === 'money' ? 0.01 : 'any')} />
            break
          default:
            control = <Input {...common} type={f.type === 'tel' ? 'tel' : f.type} autoComplete="off" />
        }
        return (
          <Field key={f.name} label={f.label} htmlFor={common.id} required={f.required} error={err} hint={f.hint} className={span}>
            {control}
          </Field>
        )
      })}
    </form>
  )
}
