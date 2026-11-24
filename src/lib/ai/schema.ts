/**
 * Minimal JSON-Schema validator for tool inputs (the subset our tool definitions use):
 * type object/string/integer/number/boolean/array, enum, required, additionalProperties:false,
 * minimum/maximum, minLength/maxLength, maxItems, items, format: 'date' (YYYY-MM-DD).
 * Tool inputs come from the model, so every executor validates before touching data.
 */
export type JsonSchema = {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array'
  description?: string
  enum?: readonly unknown[]
  properties?: Record<string, JsonSchema>
  required?: readonly string[]
  additionalProperties?: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  items?: JsonSchema
  format?: 'date'
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function validate(schema: JsonSchema, value: unknown, path = 'input'): string[] {
  const errs: string[] = []
  if (schema.enum && !schema.enum.includes(value as never)) {
    errs.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`)
    return errs
  }
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path} must be an object`]
      const obj = value as Record<string, unknown>
      for (const r of schema.required ?? []) if (obj[r] === undefined || obj[r] === null) errs.push(`${path}.${r} is required`)
      for (const [k, v] of Object.entries(obj)) {
        const sub = schema.properties?.[k]
        if (!sub) {
          if (schema.additionalProperties === false) errs.push(`${path}.${k} is not an allowed property`)
          continue
        }
        if (v === undefined || (v === null && !(schema.required ?? []).includes(k))) continue
        errs.push(...validate(sub, v, `${path}.${k}`))
      }
      break
    }
    case 'string':
      if (typeof value !== 'string') return [`${path} must be a string`]
      if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path} is too short`)
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path} is too long (max ${schema.maxLength})`)
      if (schema.format === 'date' && (!DATE_RE.test(value) || Number.isNaN(Date.parse(value)))) errs.push(`${path} must be a date YYYY-MM-DD`)
      break
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) return [`${path} must be ${schema.type === 'integer' ? 'an integer' : 'a number'}`]
      if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path} must be ≥ ${schema.minimum}`)
      if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path} must be ≤ ${schema.maximum}`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') return [`${path} must be true or false`]
      break
    case 'array':
      if (!Array.isArray(value)) return [`${path} must be an array`]
      if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path} needs at least ${schema.minItems} item(s)`)
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path} has too many items`)
      if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items!, v, `${path}[${i}]`)))
      break
  }
  return errs
}

// small builders keep the tool definitions readable
export const S = {
  obj(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
    return { type: 'object', properties, required, additionalProperties: false }
  },
  str(description: string, extra: Partial<JsonSchema> = {}): JsonSchema {
    return { type: 'string', description, maxLength: 200, ...extra }
  },
  date(description: string): JsonSchema {
    return { type: 'string', description, format: 'date' }
  },
  int(description: string, minimum: number, maximum: number): JsonSchema {
    return { type: 'integer', description, minimum, maximum }
  },
  bool(description: string): JsonSchema {
    return { type: 'boolean', description }
  },
  num(description: string, minimum: number, maximum: number): JsonSchema {
    return { type: 'number', description, minimum, maximum }
  },
  arr(description: string, items: JsonSchema, minItems: number, maxItems: number): JsonSchema {
    return { type: 'array', description, items, minItems, maxItems }
  },
  enum(description: string, values: readonly string[]): JsonSchema {
    return { type: 'string', description, enum: values }
  },
}
