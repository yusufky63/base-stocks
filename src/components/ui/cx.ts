/** Joins class names, dropping the falsy ones. In its own module so client and server primitives can share it without importing each other. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
