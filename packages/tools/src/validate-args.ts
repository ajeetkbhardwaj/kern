import type { JsonSchema } from "@kern/protocol";

export interface ArgRepairResult {
  args: unknown;
  repaired: boolean;
  repairs: string[];
}

/**
 * Narrow, deterministic repair of common weak/local LLM tool-argument quirks
 * before strict schema validation:
 *  - parses `_raw` JSON payloads (trimming markdown fences / trailing commas)
 *  - parses JSON string payloads passed instead of an object
 *  - coerces stringified booleans/integers/numbers/arrays/objects when schema specifies that type
 */
export function repairToolArgs(schema: JsonSchema, args: unknown): ArgRepairResult {
  const repairs: string[] = [];
  let current = args;

  // Recover `{ _raw: "..." }` emitted by OpenAI adapter on malformed JSON
  if (
    current &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    "_raw" in current &&
    typeof (current as Record<string, unknown>)._raw === "string" &&
    Object.keys(current).length === 1
  ) {
    const parsed = trySalvageJson((current as Record<string, unknown>)._raw as string);
    if (parsed !== undefined) {
      current = parsed;
      repairs.push("salvaged _raw JSON");
    }
  }

  // Recover top-level JSON string for object schemas
  if (schema.type === "object" && typeof current === "string") {
    const parsed = trySalvageJson(current);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed;
      repairs.push("parsed JSON-stringified object");
    }
  }

  const repairedValue = repairBySchema(schema, current, "$", repairs);
  return { args: repairedValue, repaired: repairs.length > 0, repairs };
}

function trySalvageJson(raw: string): unknown {
  let trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Strip optional markdown code fences
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fence && fence[1]) trimmed = fence[1].trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Strip trailing commas before } or ]
    const withoutTrailingCommas = trimmed.replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(withoutTrailingCommas);
    } catch {
      return undefined;
    }
  }
}

type SimpleSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
};

function repairBySchema(schema: SimpleSchema, value: unknown, path: string, repairs: string[]): unknown {
  const type = schema.type;
  if (!type || value === undefined || value === null) return value;

  switch (type) {
    case "object": {
      let obj = value;
      if (typeof obj === "string") {
        const parsed = trySalvageJson(obj);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          obj = parsed;
          repairs.push(`${path}: parsed stringified object`);
        }
      }
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return obj;
      const props = (schema.properties ?? {}) as Record<string, SimpleSchema>;
      let out: Record<string, unknown> | null = null;
      const record = obj as Record<string, unknown>;
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in record && record[key] !== undefined) {
          const next = repairBySchema(propSchema, record[key], `${path}.${key}`, repairs);
          if (next !== record[key]) {
            if (!out) out = { ...record };
            out[key] = next;
          }
        }
      }
      return out ?? record;
    }
    case "array": {
      let arr = value;
      if (typeof arr === "string") {
        const parsed = trySalvageJson(arr);
        if (Array.isArray(parsed)) {
          arr = parsed;
          repairs.push(`${path}: parsed stringified array`);
        }
      }
      if (!Array.isArray(arr)) return arr;
      const items = schema.items as SimpleSchema | undefined;
      if (!items || typeof items !== "object") return arr;
      let changed = false;
      const mapped = arr.map((item, i) => {
        const next = repairBySchema(items, item, `${path}[${i}]`, repairs);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? mapped : arr;
    }
    case "boolean": {
      if (typeof value === "string") {
        const lower = value.trim().toLowerCase();
        if (lower === "true") {
          repairs.push(`${path}: coerced "true" -> true`);
          return true;
        }
        if (lower === "false") {
          repairs.push(`${path}: coerced "false" -> false`);
          return false;
        }
      }
      return value;
    }
    case "integer": {
      if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
        const parsed = Number.parseInt(value.trim(), 10);
        if (Number.isSafeInteger(parsed)) {
          repairs.push(`${path}: coerced "${value}" -> ${parsed}`);
          return parsed;
        }
      }
      return value;
    }
    case "number": {
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) {
          repairs.push(`${path}: coerced "${value}" -> ${parsed}`);
          return parsed;
        }
      }
      return value;
    }
    default:
      return value;
  }
}

/**
 * Minimal JSON-schema validation for tool arguments.
 * Covers the subset we actually emit in tool inputSchemas:
 * type: object with properties/required, scalar types, arrays.
 * Anything fancier passes through (providers own their dialect).
 */
export function validateArgs(schema: JsonSchema, args: unknown): string[] {
  const errors: string[] = [];
  checkValue(schema, args, "$", errors);
  return errors;
}

function checkValue(schema: SimpleSchema, value: unknown, path: string, errors: string[]): void {
  const type = schema.type;
  if (type === undefined) return;

  switch (type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${path}: expected object`);
        return;
      }
      const record = value as Record<string, unknown>;
      for (const req of schema.required ?? []) {
        if (!(req in record) || record[req] === undefined) {
          errors.push(`${path}.${req}: required field missing`);
        }
      }
      const props = (schema.properties ?? {}) as Record<string, SimpleSchema>;
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in record && record[key] !== undefined) {
          checkValue(propSchema, record[key], `${path}.${key}`, errors);
        }
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        return;
      }
      const items = schema.items as SimpleSchema | undefined;
      if (items && typeof items === "object") {
        for (let i = 0; i < value.length; i++) {
          checkValue(items, value[i], `${path}[${i}]`, errors);
        }
      }
      break;
    }
    case "string": {
      if (typeof value !== "string") errors.push(`${path}: expected string`);
      break;
    }
    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) errors.push(`${path}: expected number`);
      break;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) errors.push(`${path}: expected integer`);
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
      break;
    }
    default:
      break;
  }
}
