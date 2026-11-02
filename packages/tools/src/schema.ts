// Small JSON Schema validator for tool arguments: the subset tool definitions use.

import type { JsonSchema } from "@trail-agent/protocol"

/** Returns readable problems; empty when the value matches. */
export function validate(schema: JsonSchema, value: unknown, path = "arguments"): string[] {
  const problems: string[] = []
  const type = schema.type as string | undefined
  if (value && typeof value === "object" && "__invalid_json__" in value) {
    return [`${path} were not valid JSON: ${String((value as { __invalid_json__: unknown }).__invalid_json__).slice(0, 200)}`]
  }
  if (type && !matchesType(type, value)) return [`${path} should be ${type}`]
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${path} should be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`)
  }
  if (type === "object" && value && typeof value === "object") {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>
    for (const key of (schema.required ?? []) as string[]) {
      if ((value as Record<string, unknown>)[key] === undefined) problems.push(`${path}.${key} is required`)
    }
    for (const [key, child] of Object.entries(properties)) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) problems.push(...validate(child, v, `${path}.${key}`))
    }
  }
  if (type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => problems.push(...validate(schema.items as JsonSchema, item, `${path}[${i}]`)))
  }
  return problems
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value)
    case "array":
      return Array.isArray(value)
    case "integer":
      return Number.isInteger(value)
    case "number":
      return typeof value === "number"
    default:
      return typeof value === type
  }
}
