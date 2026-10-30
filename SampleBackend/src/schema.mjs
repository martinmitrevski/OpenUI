// Minimal JSON Schema checks for tool inputs, covering what tools.json uses: object schemas with
// typed properties, enums and required keys.

const TYPE_CHECKS = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  array: (value) => Array.isArray(value),
};

/** Returns a description of the first problem with `input`, or `null` when it matches `schema`. */
export function validateInput(schema, input) {
  if (!TYPE_CHECKS.object(input)) return "input must be an object";
  const properties = schema?.properties ?? {};
  for (const key of schema?.required ?? []) {
    if (input[key] === undefined) return `missing required property "${key}"`;
  }
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!property) {
      if (schema?.additionalProperties === false) return `unexpected property "${key}"`;
      continue;
    }
    const check = TYPE_CHECKS[property.type];
    if (check && !check(value)) return `property "${key}" must be of type ${property.type}`;
    if (Array.isArray(property.enum) && !property.enum.includes(value)) {
      return `property "${key}" must be one of ${property.enum.map((option) => JSON.stringify(option)).join(", ")}`;
    }
  }
  return null;
}
