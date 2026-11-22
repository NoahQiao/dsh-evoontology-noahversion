/**
 * Per-kind node body schemas and a deliberately small JSON Schema subset.
 *
 * The subset is: type / properties / required / additionalProperties / items /
 * enum / minItems / maxItems / pattern / oneOf. That is exactly what the node
 * bodies need; pulling a dependency for the rest would break the "one file,
 * no install" property of this bundle.
 */

const STRING = { type: 'string' }
const STRING_ARRAY = { type: 'array', items: STRING }

export const KINDS = ['term', 'mapping', 'constraint', 'evidence']

export const BODY_SCHEMA = {
  term: {
    type: 'object',
    additionalProperties: false,
    required: ['definition', 'evidence'],
    properties: {
      definition: { type: 'string', minLength: 1 },
      aliases: STRING_ARRAY,
      unit: { type: 'string' },
      notes: { type: 'string' },
      evidence: STRING_ARRAY
    },
    _doc: '一个业务概念。definition 是给人看的说法，unit/aliases 是机读的线索。'
  },
  mapping: {
    type: 'object',
    additionalProperties: false,
    required: ['table', 'column', 'term', 'evidence'],
    properties: {
      table: { type: 'string', minLength: 1 },
      column: { type: 'string', minLength: 1 },
      term: { type: 'string', minLength: 1 },
      transform: { type: 'string' },
      note: { type: 'string' },
      evidence: STRING_ARRAY
    },
    _doc: '物理列 → 语义术语。transform 记录两边的换算（例如 mW → W 除以 1000）。'
  },
  constraint: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'subject', 'value', 'evidence'],
    properties: {
      kind: { type: 'string', enum: ['unit', 'range', 'enum', 'ratio', 'pattern'] },
      subject: { type: 'string', minLength: 1 },
      value: {},
      note: { type: 'string' },
      evidence: STRING_ARRAY
    },
    _doc: '取值解释。unit/range/enum/ratio/pattern 五选一，subject 指向 term 或 mapping 节点。'
  },
  evidence: {
    type: 'object',
    additionalProperties: false,
    required: ['source', 'probe', 'result'],
    properties: {
      source: { type: 'string', minLength: 1 },
      probe: { type: 'string', minLength: 1 },
      result: { type: 'string' },
      digest: { type: 'string' },
      note: { type: 'string' }
    },
    _doc: '一次可复现的观察：source 说在哪看，probe 是怎么看，result 是看到了什么。'
  }
}

export const EDGE_TYPES = ['association', 'hierarchy', 'composition', 'equivalence', 'derivation']

export const CONNECTOR_KINDS = ['sqlite', 'csv', 'json']

function fail(path, message, errors) {
  errors.push({ path, message })
}

function checkType(value, type) {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

/** Validate `value` against `schema`; returns a (possibly empty) error list. */
export function validate(value, schema, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors

  if (schema.oneOf) {
    const passing = schema.oneOf.filter((branch) => validate(value, branch, path, []).length === 0)
    if (passing.length !== 1) fail(path, 'must match exactly one of the allowed shapes', errors)
    return errors
  }

  if (schema.type && !checkType(value, schema.type)) {
    fail(path, `expected ${schema.type}, got ${Array.isArray(value) ? 'array' : typeof value}`, errors)
    return errors
  }

  if (schema.enum && !schema.enum.includes(value)) {
    fail(path, `must be one of ${schema.enum.join(' | ')}`, errors)
  }

  if (schema.const !== undefined && value !== schema.const) {
    fail(path, `must be ${JSON.stringify(schema.const)}`, errors)
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(path, `must be at least ${schema.minLength} characters`, errors)
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      fail(path, `must match ${schema.pattern}`, errors)
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(path, `must have at least ${schema.minItems} items`, errors)
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(path, `must have at most ${schema.maxItems} items`, errors)
    }
    if (schema.items) value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`, errors))
  }

  if (checkType(value, 'object')) {
    for (const key of schema.required || []) {
      if (value[key] === undefined) fail(`${path}.${key}`, 'is required', errors)
    }
    const properties = schema.properties || {}
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) {
        validate(child, properties[key], `${path}.${key}`, errors)
      } else if (schema.additionalProperties === false) {
        fail(`${path}.${key}`, 'is not an allowed field', errors)
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(child, schema.additionalProperties, `${path}.${key}`, errors)
      }
    }
  }

  return errors
}

export function describeErrors(errors, limit = 6) {
  return errors.slice(0, limit).map((e) => `${e.path}: ${e.message}`).join('; ')
}
