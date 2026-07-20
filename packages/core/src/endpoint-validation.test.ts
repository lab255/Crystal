import { describe, expect, it } from "vitest";
import {
  classifyValidationMiddleware,
  detectEndpointValidation,
  detectHandlerValidation,
} from "./endpoint-validation.js";

describe("classifyValidationMiddleware", () => {
  it("recognizes celebrate", () => {
    const hit = classifyValidationMiddleware({
      text: "celebrate({ [Segments.BODY]: createFormSchema })",
      line: 12,
    });
    expect(hit).toMatchObject({ kind: "celebrate", target: "request", line: 12 });
    expect(hit!.label).toContain("celebrate(");
  });

  it("recognizes express-validator chains with their target", () => {
    expect(
      classifyValidationMiddleware({ text: 'body("email").isEmail().normalizeEmail()' }),
    ).toMatchObject({ kind: "express-validator", target: "body" });
    expect(classifyValidationMiddleware({ text: 'param("id").isUUID()' })).toMatchObject({
      kind: "express-validator",
      target: "params",
    });
    expect(classifyValidationMiddleware({ text: 'query("page").optional().isInt()' })).toMatchObject(
      { kind: "express-validator", target: "query" },
    );
  });

  it("recognizes zod middleware wrappers", () => {
    expect(
      classifyValidationMiddleware({ text: 'zValidator("json", createUserSchema)' }),
    ).toMatchObject({ kind: "zod", target: "body" });
    expect(
      classifyValidationMiddleware({ text: "validateRequestBody(schema)" }),
    ).toMatchObject({ kind: "zod", target: "body" });
  });

  it("flags validation-named identifiers as generic middleware", () => {
    expect(classifyValidationMiddleware({ text: "validateSubmission" })).toMatchObject({
      kind: "middleware",
    });
    expect(classifyValidationMiddleware({ text: "validate(scheduleSchema)" })).toMatchObject({
      kind: "middleware",
    });
  });

  it("ignores non-validation middleware", () => {
    expect(classifyValidationMiddleware({ text: "requireAuth" })).toBeNull();
    expect(classifyValidationMiddleware({ text: "rateLimit({ windowMs: 100 })" })).toBeNull();
    expect(classifyValidationMiddleware({ text: "(req, res, next) => next()" })).toBeNull();
  });
});

describe("detectHandlerValidation", () => {
  it("finds zod parses on request data with the right target and line", () => {
    const hits = detectHandlerValidation({
      text: "async (req, res) => {\n  const data = createFormSchema.parse(req.body);\n  res.json(data);\n}",
      line: 10,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "zod", target: "body", line: 11 });
  });

  it("finds safeParse and schema-named receivers without req access", () => {
    const hits = detectHandlerValidation({
      text: "const parsed = querySchema.safeParse(input);",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("zod");
  });

  it("finds joi validates", () => {
    const hits = detectHandlerValidation({
      text: "const { error } = scheduleSchema.validate(req.body);",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "joi", target: "body" });
  });

  it("ignores JSON.parse and unrelated parses", () => {
    expect(
      detectHandlerValidation({ text: "const x = JSON.parse(raw); const d = Date.parse(s);" }),
    ).toEqual([]);
  });
});

describe("detectEndpointValidation", () => {
  it("combines middleware and handler evidence, deduplicated", () => {
    const hits = detectEndpointValidation({
      middleware: [
        { text: "requireAuth", line: 5 },
        { text: "celebrate({ [Segments.BODY]: schema })", line: 5 },
      ],
      handler: { text: "(req, res) => { const d = bodySchema.parse(req.body); }", line: 5 },
    });
    expect(hits.map((h) => h.kind)).toEqual(["celebrate", "zod"]);
  });

  it("returns [] when nothing validates", () => {
    expect(
      detectEndpointValidation({
        middleware: [{ text: "requireAuth" }],
        handler: { text: "(req, res) => res.json(list())" },
      }),
    ).toEqual([]);
  });
});
