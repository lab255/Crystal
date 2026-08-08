import { describe, expect, it } from "vitest";
import type { CodeFileDetail, SystemEndpoint } from "@crystal/core";
import { endpointHandlerCandidates } from "./trace.js";

describe("endpointHandlerCandidates", () => {
  it("prefers the imported handler declaration over the registration site", () => {
    const endpoint: SystemEndpoint = {
      method: "POST",
      path: "/orders",
      file: "src/routes.ts",
      line: 12,
      handler: "Orders.create",
    };
    const detail: CodeFileDetail = {
      path: endpoint.file,
      module: "src",
      loc: 30,
      imports: [
        {
          specifier: "./orders.js",
          resolved: "src/orders.ts",
          targetModule: "src",
          names: ["Orders"],
          external: false,
        },
      ],
      exports: [],
      symbols: [{ name: "registerRoutes", kind: "function", line: 8, endLine: 20 }],
      importedBy: [],
    };

    expect(endpointHandlerCandidates(endpoint, detail).slice(0, 2)).toEqual([
      { file: "src/orders.ts", symbol: "create" },
      { file: "src/orders.ts", symbol: "Orders" },
    ]);
  });
});
