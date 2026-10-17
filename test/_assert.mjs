/** Minimal dependency-free assertions for the standalone test scripts. */

export function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`assertion failed: ${message}\n  expected: ${e}\n  actual:   ${a}`)
}

export function assertMatch(value, pattern, message) {
  if (!pattern.test(String(value))) {
    throw new Error(`assertion failed: ${message}\n  value:    ${String(value)}\n  pattern:  ${pattern}`)
  }
}
