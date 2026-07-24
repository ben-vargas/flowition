// Minimal JSON Schema validator — the subset workflow authors actually use:
// type, properties, required, additionalProperties:false, items, enum, const,
// minItems/maxItems, minLength/maxLength, minimum/maximum, anyOf, nullable via type arrays.
// Any OTHER keyword (pattern, oneOf, multipleOf, format, …) is rejected LOUDLY:
// a silently ignored constraint would let authors believe they validated.
function jsonEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) &&
      a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]))
  }
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  return aKeys.length === bKeys.length &&
    aKeys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
}

// Keywords the validator ENFORCES; the list is quoted verbatim in the
// unsupported-keyword error, so authors see exactly what they can use.
const SUPPORTED = ['type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'anyOf']
const SUPPORTED_SET = new Set(SUPPORTED)
// Pure annotations carry no validation semantics — allowed and ignored.
const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples', '$comment', '$schema', '$id'])

// Structural walk over the SCHEMA (independent of any value): every keyword the
// validator does not implement errors loudly, at any nesting depth — including
// branches a given value would never reach (an absent optional property, an
// unmatched anyOf arm). Run once per validate() call, not per value visit.
function checkKeywords(schema, path, errs) {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) return
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED_SET.has(k) && !ANNOTATIONS.has(k)) {
      errs.push(`unsupported schema keyword "${k}" at ${path} — supported: ${SUPPORTED.join(', ')} (plus annotations: ${[...ANNOTATIONS].join(', ')})`)
    }
  }
  // Same silent-accept class as unknown keywords: shapes this validator would
  // ignore rather than enforce are rejected, not skipped.
  if (Array.isArray(schema.items)) errs.push(`unsupported tuple-form "items" array at ${path} — items must be a single schema`)
  else if (schema.items != null) checkKeywords(schema.items, `${path}[*]`, errs)
  if (schema.additionalProperties != null && typeof schema.additionalProperties !== 'boolean') {
    errs.push(`unsupported non-boolean "additionalProperties" at ${path} — only true/false is enforced`)
  }
  for (const k of Object.keys(schema.properties ?? {})) checkKeywords(schema.properties[k], `${path}.${k}`, errs)
  if (Array.isArray(schema.anyOf)) for (const s of schema.anyOf) checkKeywords(s, path, errs)
}

export function validate(schema, value, path = '$') {
  const errs = []
  checkKeywords(schema, path, errs)
  errs.push(...validateValue(schema, value, path))
  return errs
}

function validateValue(schema, value, path) {
  const errs = []
  const err = (msg) => errs.push(`${path}: ${msg}`)
  if (schema == null || typeof schema !== 'object') return errs

  if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
    err(`expected const ${JSON.stringify(schema.const)}`)
  }
  if (schema.enum && !schema.enum.some((e) => jsonEqual(e, value))) {
    err(`expected one of ${JSON.stringify(schema.enum)}`)
  }
  if (schema.anyOf) {
    const branches = schema.anyOf.map((s) => validateValue(s, value, path))
    if (!branches.some((b) => b.length === 0)) err(`matched no anyOf branch (first: ${branches[0]?.[0] ?? 'none'})`)
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const ok = types.some((t) => t === actual || (t === 'integer' && actual === 'number' && Number.isInteger(value)) || (t === 'number' && actual === 'number'))
    if (!ok) { err(`expected type ${types.join('|')}, got ${actual}`); return errs }
  }

  if (typeof value === 'string') {
    const length = Array.from(value).length
    if (schema.minLength != null && length < schema.minLength) err(`string shorter than minLength ${schema.minLength}`)
    if (schema.maxLength != null && length > schema.maxLength) err(`string longer than maxLength ${schema.maxLength}`)
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) err(`below minimum ${schema.minimum}`)
    if (schema.maximum != null && value > schema.maximum) err(`above maximum ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) err(`fewer than minItems ${schema.minItems}`)
    if (schema.maxItems != null && value.length > schema.maxItems) err(`more than maxItems ${schema.maxItems}`)
    if (schema.items) value.forEach((v, i) => errs.push(...validateValue(schema.items, v, `${path}[${i}]`)))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {}
    for (const k of schema.required || []) {
      if (!Object.hasOwn(value, k)) err(`missing required property "${k}"`)
    }
    for (const k of Object.keys(properties)) {
      if (Object.hasOwn(properties, k) && Object.hasOwn(value, k)) {
        errs.push(...validateValue(properties[k], value[k], `${path}.${k}`))
      }
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!Object.hasOwn(properties, k)) err(`unexpected property "${k}"`)
      }
    }
  }
  return errs
}

export function schemaInstruction(schema) {
  return (
    '\n\n---\nOUTPUT CONTRACT: Your FINAL message must be exactly one JSON value conforming to this JSON Schema — ' +
    'no prose before or after, no markdown fences:\n' + JSON.stringify(schema)
  )
}
