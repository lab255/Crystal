import type { SchemaSurface } from "@crystal/core";

/** ER membership follows the schema's declaring model file, like the schemas list. */
export function schemaLensMemberIds(
  schemas: readonly SchemaSurface[],
  fileInLens: (file: string) => boolean,
): ReadonlySet<string> {
  return new Set(schemas.filter((schema) => fileInLens(schema.file)).map((schema) => schema.id));
}
