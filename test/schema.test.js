import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validate } from '../src/schema.js'
import { parseJsonLoose, canonical, assertJsonValue } from '../src/util.js'

test('validate: types, required, nested, arrays, enum', () => {
  const schema = {
    type: 'object',
    required: ['name', 'items'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 0 },
      kind: { enum: ['a', 'b'] },
      items: { type: 'array', minItems: 1, items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    },
  }
  assert.deepEqual(validate(schema, { name: 'x', items: [{ id: '1' }] }), [])
  assert.ok(validate(schema, { items: [{ id: '1' }] }).some((e) => e.includes('missing required property "name"')))
  assert.ok(validate(schema, { name: 'x', items: [] }).some((e) => e.includes('minItems')))
  assert.ok(validate(schema, { name: 'x', items: [{ id: 1 }] }).some((e) => e.includes('$.items[0].id')))
  assert.ok(validate(schema, { name: 'x', items: [{ id: '1' }], extra: 1 }).some((e) => e.includes('unexpected property')))
  assert.ok(validate(schema, { name: 'x', kind: 'z', items: [{ id: '1' }] }).some((e) => e.includes('one of')))
})

test('validate: type arrays (nullable) and anyOf', () => {
  assert.deepEqual(validate({ type: ['string', 'null'] }, null), [])
  assert.deepEqual(validate({ anyOf: [{ type: 'string' }, { type: 'number' }] }, 5), [])
  assert.ok(validate({ anyOf: [{ type: 'string' }] }, 5).length > 0)
})

test('validate: anyOf evaluates sibling constraints', () => {
  const errors = validate({ type: 'object', required: ['id'], anyOf: [{}] }, {})
  assert.ok(errors.some((e) => e.includes('missing required property "id"')))

  const failedBranch = validate({ type: 'string', minLength: 2, anyOf: [{ const: 'x' }] }, '')
  assert.ok(failedBranch.some((e) => e.includes('matched no anyOf branch')))
  assert.ok(failedBranch.some((e) => e.includes('minLength')))
})

test('validate: const and enum ignore object key order', () => {
  const value = { nested: { b: 2, a: 1 }, items: [{ y: 2, x: 1 }] }
  const reordered = { items: [{ x: 1, y: 2 }], nested: { a: 1, b: 2 } }

  assert.deepEqual(validate({ const: reordered }, value), [])
  assert.deepEqual(validate({ enum: [reordered] }, value), [])
  assert.ok(validate({ const: { items: [2, 1] } }, { items: [1, 2] }).length > 0)
})

test('validate: string lengths count Unicode code points', () => {
  assert.deepEqual(validate({ type: 'string', minLength: 1, maxLength: 1 }, '😀'), [])
  assert.ok(validate({ type: 'string', maxLength: 1 }, '😀a').some((e) => e.includes('maxLength')))
})

test('validate: object membership ignores prototype properties', () => {
  const required = { type: 'object', required: ['constructor'] }
  assert.ok(validate(required, {}).some((e) => e.includes('missing required property "constructor"')))
  assert.deepEqual(validate(required, { constructor: 'x' }), [])

  const closed = {
    type: 'object',
    additionalProperties: false,
    properties: { a: {} },
  }
  assert.ok(validate(closed, { a: 1, toString: 1 }).some((e) => e.includes('unexpected property "toString"')))
  assert.deepEqual(validate(closed, { a: 1 }), [])

  const declared = {
    type: 'object',
    additionalProperties: false,
    properties: { toString: { type: 'number' } },
  }
  assert.deepEqual(validate(declared, { toString: 1 }), [])
  assert.ok(validate(declared, { toString: 'x' }).some((e) => e.includes('$.toString')))
})

test('validate: unsupported keywords are rejected loudly, never silently ignored', () => {
  assert.ok(validate({ type: 'string', pattern: '^a' }, 'b').some((e) => e.includes('unsupported schema keyword "pattern" at $')))
  assert.ok(validate({ oneOf: [{ type: 'string' }] }, 'x').some((e) => e.includes('unsupported schema keyword "oneOf"')))
  assert.ok(validate({ type: 'number', multipleOf: 2 }, 3).some((e) => e.includes('unsupported schema keyword "multipleOf"')))
  // the error names the full supported set so authors know what they CAN use
  assert.ok(validate({ format: 'email' }, 'x')[0].includes('supported: type, required, properties, additionalProperties, items, enum, const, minimum, maximum, minLength, maxLength, minItems, maxItems, anyOf'))
})

test('validate: annotations stay allowed — a fully annotated supported schema is clean', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.com/x',
    title: 'T',
    description: 'd',
    default: {},
    examples: [{ a: 'x' }],
    $comment: 'c',
    type: 'object',
    required: ['a'],
    additionalProperties: false,
    properties: { a: { type: 'string', minLength: 1, description: 'inner annotation' } },
  }
  assert.deepEqual(validate(schema, { a: 'x' }), [])
})

test('validate: nested unsupported keywords are caught, even off the value path', () => {
  // property absent from the value — a value-driven walk would never reach it
  const nestedProp = validate({ type: 'object', properties: { x: { type: 'string', pattern: '^a' } } }, {})
  assert.ok(nestedProp.some((e) => e.includes('unsupported schema keyword "pattern" at $.x')))
  const nestedItems = validate({ type: 'array', items: { not: {} } }, [])
  assert.ok(nestedItems.some((e) => e.includes('unsupported schema keyword "not" at $[*]')))
  // an anyOf branch the value happens to satisfy still cannot smuggle keywords
  const nestedAnyOf = validate({ anyOf: [{ type: 'string' }, { allOf: [{}] }] }, 'ok')
  assert.ok(nestedAnyOf.some((e) => e.includes('unsupported schema keyword "allOf"')))
  // shapes the validator would silently skip are rejected, not ignored
  assert.ok(validate({ items: [{ type: 'string' }] }, ['x']).some((e) => e.includes('tuple-form "items"')))
  assert.ok(validate({ additionalProperties: {} }, {}).some((e) => e.includes('non-boolean "additionalProperties"')))
})

test('parseJsonLoose: fences, prose, plain', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 })
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseJsonLoose('Sure! Here is the result:\n{"a": [1,2]}\nHope that helps.'), { a: [1, 2] })
  assert.equal(parseJsonLoose('no json here'), undefined)
})

test('canonical: key order independence', () => {
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), canonical({ a: [{ c: 3, d: 2 }], b: 1 }))
})

test('validate: malformed keyword shapes are rejected loudly, including explicit null', () => {
  assert.ok(validate({ anyOf: { type: 'string' } }, 'x').some((e) => e.includes('malformed "anyOf"')))
  assert.ok(validate({ enum: {} }, 'x').some((e) => e.includes('malformed "enum"')))
  assert.ok(validate({ required: {} }, {}).some((e) => e.includes('malformed "required"')))
  assert.ok(validate({ properties: [] }, {}).some((e) => e.includes('malformed "properties"')))
  // explicit null is malformed too — not "absent"
  assert.ok(validate({ anyOf: null }, 'x').some((e) => e.includes('malformed "anyOf"')))
  assert.ok(validate({ enum: null }, 'x').some((e) => e.includes('malformed "enum"')))
  assert.ok(validate({ required: null }, {}).some((e) => e.includes('malformed "required"')))
  assert.ok(validate({ properties: null }, {}).some((e) => e.includes('malformed "properties"')))
  // nested malformed shapes are caught off the value path too
  assert.ok(validate({ type: 'object', properties: { x: { enum: {} } } }, {}).some((e) => e.includes('malformed "enum" at $.x')))
})

test('assertJsonValue: sparse arrays are rejected, never keyed or persisted sparse', () => {
  // Array#map preserves holes — a sparse array would canonical()-collide with
  // a shorter array while JSON-serializing as [null]; fresh and replayed
  // results must never diverge like that.
  assert.throws(() => assertJsonValue(Array(1), 'v'), /array hole/)
  assert.throws(() => assertJsonValue([1, , 3], 'v'), /at \[1\] is an array hole/)
  assert.throws(() => assertJsonValue({ a: [ , ] }, 'v'), /at a\[0\] is an array hole/)
  // dense arrays still pass untouched
  assert.deepEqual(assertJsonValue([1, null, 'x'], 'v'), [1, null, 'x'])
})

test('assertJsonValue: an own __proto__ property survives the copy', () => {
  const v = JSON.parse('{"__proto__":{"x":1},"y":2}')
  const out = assertJsonValue(v, 'v')
  assert.ok(Object.hasOwn(out, '__proto__'), 'own __proto__ key preserved')
  assert.deepEqual(Object.getOwnPropertyDescriptor(out, '__proto__').value, { x: 1 })
  assert.equal(Object.getPrototypeOf(out), Object.prototype, 'real prototype untouched')
  assert.equal(out.y, 2)
  // identity holds across the JSON round trip a journal replay performs
  assert.equal(canonical(JSON.parse(JSON.stringify(out))), canonical(out))
})

test('assertJsonValue: -0 normalizes to 0 — fresh and replayed results must be identical', () => {
  // JSON.stringify(-0) === "0", so an un-normalized -0 would differ from its
  // own journal replay (Object.is distinguishes them; 1/x flips sign).
  assert.ok(Object.is(assertJsonValue(-0, 'v'), 0))
  assert.ok(!Object.is(assertJsonValue(-0, 'v'), -0))
  assert.ok(Object.is(assertJsonValue({ a: [-0] }, 'v').a[0], 0))
  // ordinary numbers pass through untouched
  assert.equal(assertJsonValue(-1.5, 'v'), -1.5)
})
