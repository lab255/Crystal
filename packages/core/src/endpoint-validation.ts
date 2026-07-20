/**
 * Endpoint validation detection — what request validation a served route
 * actually enforces, read straight from the registration site: the middleware
 * chain between path and handler (`celebrate(schema)`, `body("email")…`,
 * `zValidator(...)`) and the handler body itself (`schema.parse(req.body)`).
 *
 * Pure text heuristics over source snippets: the server's analyzer hands the
 * argument texts it already has in the AST, this module names what they are.
 * "No validation detected" is a result, not a failure — the API explorer
 * renders it as exactly that.
 */

export type EndpointValidationKind =
  | "zod"
  | "joi"
  | "celebrate"
  | "express-validator"
  | "middleware";

export interface EndpointValidation {
  kind: EndpointValidationKind;
  /** Compact evidence, e.g. `celebrate(createFormSchema)` or `bodySchema.parse(req.body)`. */
  label: string;
  /** Request part the check covers, when inferable. */
  target?: "body" | "query" | "params" | "headers" | "request";
  /** 1-based line of the evidence, when known. */
  line?: number;
}

/** One snippet of source to inspect, with the 1-based line it starts on. */
export interface ValidationSnippet {
  text: string;
  line?: number;
}

/** First line of a snippet, whitespace-collapsed and capped — chip-sized evidence. */
function compact(text: string, max = 80): string {
  const one = text.split("\n")[0]!.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const EXPRESS_VALIDATOR_TARGETS: Record<string, EndpointValidation["target"]> = {
  body: "body",
  query: "query",
  param: "params",
  header: "headers",
  check: "request",
  oneOf: "request",
  checkSchema: "request",
};

const ZOD_MIDDLEWARE_RE = /^\s*(?:zValidator|validateRequest(?:Body|Query|Params)?|processRequest(?:Body|Query|Params)?)\s*\(/;
const REQ_PART_RE = /req(?:uest)?\.(body|query|params|headers)/;

function targetOfReqPart(text: string): EndpointValidation["target"] {
  const m = REQ_PART_RE.exec(text);
  return m ? (m[1] as EndpointValidation["target"]) : "request";
}

/** Classify one middleware argument of a route registration; null when it isn't validation. */
export function classifyValidationMiddleware(snippet: ValidationSnippet): EndpointValidation | null {
  const text = snippet.text.trim();
  const line = snippet.line;
  if (/^celebrate\s*\(/.test(text)) {
    return { kind: "celebrate", label: compact(text), target: "request", line };
  }
  const evCall = /^([A-Za-z_$][\w$]*)\s*\(/.exec(text);
  if (evCall && evCall[1]! in EXPRESS_VALIDATOR_TARGETS && /\.\w+\s*\(|\)\s*$/.test(text)) {
    return {
      kind: "express-validator",
      label: compact(text),
      target: EXPRESS_VALIDATOR_TARGETS[evCall[1]!],
      line,
    };
  }
  if (ZOD_MIDDLEWARE_RE.test(text)) {
    return { kind: "zod", label: compact(text), target: targetOfZodWrapper(text), line };
  }
  // `validate(fooSchema)`, `validator(schema)`, `withValidation(...)` — a
  // generic wrapper whose argument looks like a schema.
  if (/^[A-Za-z_$][\w$]*[Vv]alid(?:ate|ation|ator)\w*\s*\(/.test(text) || /^valid(?:ate|ator)\w*\s*\(/i.test(text)) {
    return { kind: "middleware", label: compact(text), target: "request", line };
  }
  // A bare identifier whose name says validation (`validateForm`,
  // `formValidator`) — referenced middleware, body unseen.
  if (/^[A-Za-z_$][\w$]*$/.test(text) && /valid|schema/i.test(text)) {
    return { kind: "middleware", label: compact(text), target: "request", line };
  }
  return null;
}

function targetOfZodWrapper(text: string): EndpointValidation["target"] {
  if (/Body\s*\(/.test(text)) return "body";
  if (/Query\s*\(/.test(text)) return "query";
  if (/Params\s*\(/.test(text)) return "params";
  const zv = /zValidator\s*\(\s*["'](json|form|body|query|param|header)["']/.exec(text);
  if (zv) {
    const t = zv[1]!;
    if (t === "json" || t === "form" || t === "body") return "body";
    if (t === "query") return "query";
    if (t === "param") return "params";
    return "headers";
  }
  return "request";
}

const PARSE_RE =
  /([A-Za-z_$][\w$.]*)\.(?:parseAsync|parse|safeParseAsync|safeParse)\s*\(\s*([^)]*)/g;
const JOI_VALIDATE_RE =
  /([A-Za-z_$][\w$.]*)\.(?:validateAsync|validate)\s*\(\s*(req(?:uest)?\.\w+[^),]*|[^),]*)/g;
const JOI_ATTEMPT_RE = /\bJoi\.attempt\s*\(\s*([^,)]*)/g;

/** 1-based line of a match inside a snippet that starts at `startLine`. */
function lineAt(text: string, index: number, startLine: number | undefined): number | undefined {
  if (startLine == null) return undefined;
  let line = startLine;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Validation calls inside a handler body: zod parses and joi validates on request data. */
export function detectHandlerValidation(snippet: ValidationSnippet): EndpointValidation[] {
  const { text } = snippet;
  const out: EndpointValidation[] = [];
  for (const m of text.matchAll(PARSE_RE)) {
    const receiver = m[1]!;
    const arg = m[2] ?? "";
    // Only calls that read request data (or receivers that are clearly
    // schemas) — `JSON.parse(...)`, `date.parse(...)` must not count.
    const onRequest = REQ_PART_RE.test(arg);
    const schemaish = /schema$|Schema$/.test(receiver) || receiver === "z" || /^z\./.test(receiver);
    if (!onRequest && !schemaish) continue;
    if (/^(JSON|Date|Number|parseInt|url|URL|path)$/.test(receiver)) continue;
    out.push({
      kind: "zod",
      label: compact(`${m[0]!.trimEnd()})`),
      target: onRequest ? targetOfReqPart(arg) : "request",
      line: lineAt(text, m.index, snippet.line),
    });
  }
  for (const m of text.matchAll(JOI_VALIDATE_RE)) {
    const receiver = m[1]!;
    const arg = m[2] ?? "";
    const joiish = /[Ss]chema$/.test(receiver) || receiver.startsWith("Joi");
    if (!joiish && !REQ_PART_RE.test(arg)) continue;
    out.push({
      kind: "joi",
      label: compact(`${m[0]!.trimEnd()})`),
      target: REQ_PART_RE.test(arg) ? targetOfReqPart(arg) : "request",
      line: lineAt(text, m.index, snippet.line),
    });
  }
  for (const m of text.matchAll(JOI_ATTEMPT_RE)) {
    out.push({
      kind: "joi",
      label: compact(`${m[0]!.trimEnd()})`),
      target: REQ_PART_RE.test(m[1] ?? "") ? targetOfReqPart(m[1]!) : "request",
      line: lineAt(text, m.index, snippet.line),
    });
  }
  return out;
}

/**
 * Everything a route registration enforces: the middleware chain classified,
 * plus validation calls found in the handler body (when its source is known).
 * Deduplicated by kind+label; middleware first, in chain order.
 */
export function detectEndpointValidation(input: {
  /** Source text of each argument between the path and the handler. */
  middleware: ValidationSnippet[];
  /** Handler body source (inline handler, or the resolved named handler), when available. */
  handler?: ValidationSnippet | null;
}): EndpointValidation[] {
  const out: EndpointValidation[] = [];
  for (const arg of input.middleware) {
    const hit = classifyValidationMiddleware(arg);
    if (hit) out.push(hit);
  }
  if (input.handler) out.push(...detectHandlerValidation(input.handler));
  const seen = new Set<string>();
  return out.filter((v) => {
    const key = `${v.kind}|${v.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
