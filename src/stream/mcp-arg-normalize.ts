/** Normalize Cursor-shaped MCP tool args into the registry contracts Pi validates. */

/** Tools whose body field is `content` in Pi but often `contents` under Cursor IDE. */
const CONTENT_BODY_TOOLS = new Set(["write", "Write"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Cursor's native Write tool uses `contents`; Pi's `write` requires `content`.
 * Models mixed into a Pi session often emit the Cursor field and fail validation
 * even though the payload arrived intact. Same pattern for a few memory fields.
 */
export function normalizeMcpToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainObject(args)) return {};
  const out: Record<string, unknown> = { ...args };
  const base = toolName.trim();

  if (CONTENT_BODY_TOOLS.has(base)) {
    if (out.content === undefined && typeof out.contents === "string") {
      out.content = out.contents;
      delete out.contents;
    }
  }

  if (base === "remember" || base === "update_memory") {
    if (out.id === undefined && (typeof out.memoryId === "number" || typeof out.memoryId === "string")) {
      out.id = out.memoryId;
      delete out.memoryId;
    }
    if (Array.isArray(out.tags)) {
      out.tags = out.tags.map((tag) => String(tag)).join(",");
    }
  }

  return out;
}

/** True when the tool schema lists at least one required argument. */
export function toolSchemaRequiresArgs(inputSchemaJson: string | undefined): boolean {
  if (!inputSchemaJson) return false;
  try {
    const schema = JSON.parse(inputSchemaJson) as { required?: unknown };
    return Array.isArray(schema.required) && schema.required.length > 0;
  } catch {
    return false;
  }
}

/**
 * Cursor sometimes emits parallel MCP siblings with an empty args map
 * (`…aws_ue1_0` filled, `…aws_ue1_1` `{}`). That is not a Pi schema bug — the
 * payload never arrived — so ask for a filled retry instead of a validation spam.
 */
export function emptyRequiredArgsError(toolName: string): string {
  return (
    `MCP tool "${toolName}" was invoked with empty arguments ({}). ` +
    "The args map never arrived from Cursor — this is not a missing field rename. " +
    "Retry once with every required argument filled from the tool schema. " +
    "If this followed another tool in the same parallel batch, prefer a sequential call."
  );
}
