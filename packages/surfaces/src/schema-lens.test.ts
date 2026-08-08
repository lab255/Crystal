import { describe, expect, it } from "vitest";
import type { SchemaSurface } from "@crystal/core";
import { schemaLensMemberIds } from "./schema-lens.js";

function schema(id: string, file: string): SchemaSurface {
  return {
    id,
    name: id,
    kind: "prisma",
    file,
    line: 1,
    fields: [],
    fieldsTruncated: false,
    usedBy: 0,
  };
}

describe("schemaLensMemberIds", () => {
  it("includes only tables whose model file belongs to the lens", () => {
    const members = schemaLensMemberIds(
      [
        schema("User", "packages/auth/prisma/schema.prisma"),
        schema("Invoice", "packages/billing/prisma/schema.prisma"),
      ],
      (file) => file.startsWith("packages/auth/"),
    );

    expect([...members]).toEqual(["User"]);
  });
});
