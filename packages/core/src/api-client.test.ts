import { describe, expect, it } from "vitest";
import {
  ApiClientStateSchema,
  resolveRequestUrl,
  resolveTemplate,
  type ApiEnvConfig,
} from "./api-client.js";

const ENV: ApiEnvConfig = {
  baseUrl: "http://localhost:3000",
  variables: [
    { key: "token", value: "abc123", secret: true },
    { key: "org", value: "crystal" },
  ],
};

describe("resolveTemplate", () => {
  it("substitutes variables and the implicit baseUrl, leaving unknowns verbatim", () => {
    expect(resolveTemplate("Bearer {{token}}", ENV)).toBe("Bearer abc123");
    expect(resolveTemplate("{{baseUrl}}/x", ENV)).toBe("http://localhost:3000/x");
    expect(resolveTemplate("{{missing}}", ENV)).toBe("{{missing}}");
    expect(resolveTemplate("plain", null)).toBe("plain");
  });
});

describe("resolveRequestUrl", () => {
  it("joins bare paths onto the base URL and passes absolutes through", () => {
    expect(resolveRequestUrl("/api/{{org}}/forms", ENV)).toBe(
      "http://localhost:3000/api/crystal/forms",
    );
    expect(resolveRequestUrl("health", ENV)).toBe("http://localhost:3000/health");
    expect(resolveRequestUrl("https://example.com/x", ENV)).toBe("https://example.com/x");
    expect(resolveRequestUrl("/x", { baseUrl: null, variables: [] })).toBe("/x");
  });
});

describe("ApiClientStateSchema", () => {
  it("defaults an empty state and tolerates unknown env ids", () => {
    const state = ApiClientStateSchema.parse({});
    expect(state).toEqual({ requests: [], envConfigs: {}, activeEnvId: null });
    const withCfg = ApiClientStateSchema.parse({
      envConfigs: { "env-1": { variables: [{ key: "a", value: "b" }] } },
    });
    expect(withCfg.envConfigs["env-1"]).toEqual({
      baseUrl: null,
      variables: [{ key: "a", value: "b" }],
    });
  });
});
