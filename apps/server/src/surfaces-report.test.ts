import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeMapAnalyzer } from "./code-map.js";
import {
  demoTargetsFromScripts,
  extractRouterScreens,
  extractSourceSchemas,
  nextAppRoute,
  nextPagesRoute,
  parsePrismaSchema,
  parseStoryFile,
} from "./surfaces-report.js";

describe("nextAppRoute", () => {
  it("derives routes from app-dir page files", () => {
    expect(nextAppRoute("app/page.tsx")).toBe("/");
    expect(nextAppRoute("src/app/(shop)/cart/page.tsx")).toBe("/cart");
    expect(nextAppRoute("apps/web/app/forms/[formId]/page.tsx")).toBe("/forms/:formId");
    expect(nextAppRoute("app/docs/[...slug]/page.tsx")).toBe("/docs/*");
    expect(nextAppRoute("app/blog/[[...slug]]/page.tsx")).toBe("/blog/*");
    expect(nextAppRoute("app/@modal/photo/page.tsx")).toBe("/photo");
  });

  it("ignores non-page files", () => {
    expect(nextAppRoute("app/api/forms/route.ts")).toBeNull();
    expect(nextAppRoute("app/components/page-header.tsx")).toBeNull();
    expect(nextAppRoute("src/lib/page.helpers.ts")).toBeNull();
  });
});

describe("nextPagesRoute", () => {
  it("derives routes from pages-dir files", () => {
    expect(nextPagesRoute("pages/index.tsx")).toBe("/");
    expect(nextPagesRoute("pages/forms/[id].tsx")).toBe("/forms/:id");
    expect(nextPagesRoute("src/pages/blog/index.jsx")).toBe("/blog");
    expect(nextPagesRoute("pages/docs/[...rest].tsx")).toBe("/docs/*");
  });

  it("excludes _app/_document/_error, api routes, and non-jsx files", () => {
    expect(nextPagesRoute("pages/_app.tsx")).toBeNull();
    expect(nextPagesRoute("pages/_document.tsx")).toBeNull();
    expect(nextPagesRoute("pages/_error.jsx")).toBeNull();
    expect(nextPagesRoute("pages/api/users.tsx")).toBeNull();
    expect(nextPagesRoute("pages/about.ts")).toBeNull();
  });
});

describe("extractRouterScreens", () => {
  it("reads JSX Route trees: nesting, element/Component, catch-alls, pathless layouts", () => {
    const screens = extractRouterScreens(
      "src/App.tsx",
      `import { Routes, Route } from "react-router-dom";
import { Dash } from "./Dash";
export function App() {
  return (
    <Routes>
      <Route path="/dash" element={<Dash />}>
        <Route path="deep/:id" element={<Dash.Panel />} />
      </Route>
      <Route element={<Layout />}>
        <Route path="/inside" element={<Inner />} />
      </Route>
      <Route path="*" element={<NotFound />} />
      <Route path="/plain" Component={Dash} />
    </Routes>
  );
}`,
    );
    const byRoute = Object.fromEntries(screens.map((s) => [s.route, s]));
    expect(byRoute["/dash"]).toMatchObject({ componentName: "Dash", line: 6 });
    expect(byRoute["/dash/deep/:id"]).toMatchObject({ componentName: "Panel" });
    expect(byRoute["/inside"]).toMatchObject({ componentName: "Inner" });
    expect(byRoute["/*"]).toMatchObject({ componentName: "NotFound" });
    expect(byRoute["/plain"]).toMatchObject({ componentName: "Dash" });
    expect(screens).toHaveLength(5);
  });

  it("reads createBrowserRouter object routes: children join, index, catch-all", () => {
    const screens = extractRouterScreens(
      "src/router.tsx",
      `import { createBrowserRouter } from "react-router";
export const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  {
    path: "/app",
    children: [
      { path: "settings", Component: Settings },
      { index: true, element: <Home /> },
    ],
  },
  { path: "*" },
]);`,
    );
    const routes = screens.map((s) => s.route);
    expect(routes).toEqual(["/", "/app/settings", "/app", "/*"]);
    // Grouping parents (path + children, no element) are not screens themselves.
    expect(screens.find((s) => s.route === "/app")!.componentName).toBe("Home"); // the index child
    expect(screens.find((s) => s.route === "/app/settings")!.componentName).toBe("Settings");
    expect(screens.find((s) => s.route === "/*")!.componentName).toBeUndefined();
  });

  it("never throws on malformed sources", () => {
    expect(extractRouterScreens("x.tsx", "const = <<<%%% nope")).toEqual([]);
  });
});

describe("parseStoryFile", () => {
  it("reads inline default-export meta with title and component", () => {
    const parsed = parseStoryFile(
      "Button.stories.tsx",
      `import { Button } from "./Button";
export default { title: "UI/Button", component: Button };
export const Primary = { args: {} };
export const argTypes = {};
export const decorators = [];`,
    );
    expect(parsed.title).toBe("UI/Button");
    expect(parsed.componentName).toBe("Button");
    expect(parsed.stories).toEqual([{ name: "Primary", line: 3 }]);
  });

  it("resolves the meta-const form through satisfies/as wrappers", () => {
    const parsed = parseStoryFile(
      "Card.stories.tsx",
      `import { Card } from "./Card";
const meta = { component: Card } satisfies Meta<typeof Card>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Big: Story = {};
export function Small() { return null; }`,
    );
    expect(parsed.title).toBeUndefined();
    expect(parsed.componentName).toBe("Card");
    expect(parsed.stories.map((s) => s.name)).toEqual(["Big", "Small"]);
  });

  it("handles as-cast metas and files without a default export", () => {
    const cast = parseStoryFile(
      "a.stories.ts",
      `const meta = { title: "T" } as Meta;\nexport default meta;\nexport const One = {};`,
    );
    expect(cast.title).toBe("T");
    expect(cast.stories.map((s) => s.name)).toEqual(["One"]);
    const bare = parseStoryFile("b.stories.ts", `export const Lonely = {};`);
    expect(bare.title).toBeUndefined();
    expect(bare.stories.map((s) => s.name)).toEqual(["Lonely"]);
  });
});

describe("extractSourceSchemas", () => {
  it("extracts zod object consts with field types and optionality", () => {
    const schemas = extractSourceSchemas(
      "src/api/validation.ts",
      `import { z } from "zod";
export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  nickname: z.string().optional(),
}).strict();
const unrelated = z.string();`,
    );
    expect(schemas).toHaveLength(1);
    expect(schemas[0]).toMatchObject({ name: "UserSchema", kind: "zod", line: 2 });
    expect(schemas[0]!.fields).toEqual([
      { name: "id", type: "z.string().uuid()" },
      { name: "email", type: "z.string().email()" },
      { name: "nickname", type: "z.string().optional()", optional: true },
    ]);
  });

  it("caps fields at 40 and flags truncation", () => {
    const body = Array.from({ length: 45 }, (_, i) => `  f${i}: z.string(),`).join("\n");
    const [schema] = extractSourceSchemas(
      "big.ts",
      `import { z } from "zod";\nexport const Big = z.object({\n${body}\n});`,
    );
    expect(schema!.fields).toHaveLength(40);
    expect(schema!.fieldsTruncated).toBe(true);
  });

  it("extracts mongoose Schema consts", () => {
    const schemas = extractSourceSchemas(
      "src/db/pet.ts",
      `import mongoose, { Schema } from "mongoose";
const PetSchema = new Schema({
  name: { type: String, required: true },
  age: Number,
});
const OtherSchema = new mongoose.Schema({ tag: String });
export const Pet = mongoose.model("Pet", PetSchema);`,
    );
    expect(schemas.map((s) => [s.name, s.kind])).toEqual([
      ["PetSchema", "mongoose"],
      ["OtherSchema", "mongoose"],
    ]);
    expect(schemas[0]!.fields).toEqual([
      { name: "name", type: "{ type: String, required: true }" },
      { name: "age", type: "Number" },
    ]);
  });

  it("gates interfaces and type aliases by schema-ish paths", () => {
    const text = `export interface User { id: string; email?: string }
export type Patch = { nickname?: string };
interface Hidden { x: number }`;
    const gated = extractSourceSchemas("src/models/user.ts", text);
    expect(gated.map((s) => [s.name, s.kind])).toEqual([
      ["User", "interface"],
      ["Patch", "type"],
    ]);
    expect(gated[0]!.fields).toEqual([
      { name: "id", type: "string" },
      { name: "email", type: "string", optional: true },
    ]);
    // A schema-ish filename gates too, a plain path does not.
    expect(extractSourceSchemas("src/lib/user.types.ts", text)).toHaveLength(2);
    expect(extractSourceSchemas("src/lib/user.ts", text)).toEqual([]);
  });

  it("never throws on malformed sources", () => {
    expect(extractSourceSchemas("x.ts", "import { z } from 'zod'; const ((( =")).toEqual([]);
  });
});

describe("parsePrismaSchema", () => {
  it("parses model blocks with optionality, skipping attributes and enums", () => {
    const schemas = parsePrismaSchema(
      "prisma/schema.prisma",
      `// generated
enum Role {
  ADMIN
  USER
}

model Post {
  id    Int     @id @default(autoincrement())
  title String
  body  String?

  @@index([title])
}

model Tag {
  name String
}`,
    );
    expect(schemas.map((s) => s.name)).toEqual(["Post", "Tag"]);
    expect(schemas[0]).toMatchObject({
      id: "prisma/schema.prisma#Post",
      kind: "prisma",
      line: 7,
      usedBy: 0,
    });
    expect(schemas[0]!.fields).toEqual([
      { name: "id", type: "Int" },
      { name: "title", type: "String" },
      { name: "body", type: "String", optional: true },
    ]);
    // Enum members leak into no model.
    expect(schemas[1]!.fields).toEqual([{ name: "name", type: "String" }]);
  });
});

describe("demoTargetsFromScripts", () => {
  it("detects vite with a port override", () => {
    expect(demoTargetsFromScripts({ dev: "vite --port 4000" })).toEqual({
      appUrl: "http://localhost:4000",
      storybookUrl: null,
    });
    expect(demoTargetsFromScripts({ dev: "vite" }).appUrl).toBe("http://localhost:5173");
  });

  it("detects next, react-scripts, and astro dev servers", () => {
    expect(demoTargetsFromScripts({ dev: "next dev -p 3005" }).appUrl).toBe("http://localhost:3005");
    expect(demoTargetsFromScripts({ start: "react-scripts start" }).appUrl).toBe(
      "http://localhost:3000",
    );
    expect(demoTargetsFromScripts({ dev: "astro dev" }).appUrl).toBe("http://localhost:4321");
  });

  it("prefers dev over start and detects storybook (ignoring builds)", () => {
    const both = demoTargetsFromScripts({
      start: "react-scripts start",
      dev: "vite",
      storybook: "storybook dev -p 7007",
      "build-storybook": "storybook build",
    });
    expect(both).toEqual({
      appUrl: "http://localhost:5173",
      storybookUrl: "http://localhost:7007",
    });
    expect(demoTargetsFromScripts({ "build-storybook": "storybook build" }).storybookUrl).toBeNull();
  });

  it("returns nulls when nothing is demoable", () => {
    expect(demoTargetsFromScripts({ dev: "tsx watch src/index.ts" })).toEqual({
      appUrl: null,
      storybookUrl: null,
    });
    expect(demoTargetsFromScripts({})).toEqual({ appUrl: null, storybookUrl: null });
  });

  it("is not fooled by vitest", () => {
    expect(demoTargetsFromScripts({ dev: "vitest watch" }).appUrl).toBeNull();
  });
});

async function write(root: string, rel: string, text: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text);
}

describe("CodeMapAnalyzer.surfaces — react-router workspace", () => {
  let root: string;
  let analyzer: CodeMapAnalyzer;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-surfaces-rr-"));
    await write(
      root,
      "package.json",
      JSON.stringify({
        name: "fixture",
        scripts: { dev: "vite --port 4100", storybook: "storybook dev -p 7007" },
      }),
    );
    await write(
      root,
      "src/router.tsx",
      `import { createBrowserRouter } from "react-router-dom";
import Home from "./views/Home.js";
import { Settings } from "./views/Settings.js";
export const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  {
    path: "/app",
    children: [
      { path: "settings", Component: Settings },
      { index: true, element: <Home /> },
    ],
  },
  { path: "*", element: <NotFound /> },
]);`,
    );
    await write(
      root,
      "src/views/Home.tsx",
      `export default function Home() {
  return <div>home</div>;
}`,
    );
    await write(
      root,
      "src/views/Settings.tsx",
      `export const Settings = (props: { compact?: boolean }) => <div>{String(props.compact)}</div>;`,
    );
    await write(
      root,
      "src/views/Settings.stories.tsx",
      `import type { Meta, StoryObj } from "@storybook/react";
import { Settings } from "./Settings.js";

const meta = {
  title: "Views/Settings",
  component: Settings,
} satisfies Meta<typeof Settings>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: {} };
export function Compact() {
  return <Settings compact />;
}
export const decorators = [];`,
    );
    await write(
      root,
      "src/api/routes.ts",
      `import express from "express";
import { UserSchema } from "../models/user.js";
const app = express();
app.get("/api/items", listItems);
app.post("/api/items", createItem);`,
    );
    await write(root, "src/api/extra.ts", `router.get("/api/items", dupHandler);`);
    await write(
      root,
      "src/models/user.ts",
      `import { z } from "zod";
export const UserSchema = z.object({
  id: z.string().uuid(),
  nickname: z.string().optional(),
});
export interface UserRow {
  id: string;
  email?: string;
}`,
    );
    await write(root, "src/util/helpers.ts", `export interface NotASchema { x: number }`);
    await write(
      root,
      "prisma/schema.prisma",
      `model Post {
  id    Int     @id @default(autoincrement())
  title String
  body  String?

  @@index([title])
}`,
    );
    analyzer = new CodeMapAnalyzer(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("detects react-router screens with resolved component files", async () => {
    const { screens } = await analyzer.surfaces();
    const byId = Object.fromEntries(screens.map((s) => [s.id, s]));
    expect(screens).toHaveLength(4);
    expect(screens.every((s) => s.source === "react-router")).toBe(true);
    expect(byId["react-router:/"]).toMatchObject({
      route: "/",
      file: "src/router.tsx",
      component: "Home",
      componentFile: "src/views/Home.tsx",
    });
    expect(byId["react-router:/app"]).toMatchObject({ component: "Home" }); // index child
    expect(byId["react-router:/app/settings"]).toMatchObject({
      component: "Settings",
      componentFile: "src/views/Settings.tsx",
    });
    // Catch-all stays listed even though its component doesn't resolve.
    expect(byId["react-router:/*"]).toMatchObject({ component: "NotFound" });
    expect(byId["react-router:/*"]!.componentFile).toBeUndefined();
    // Sorted by route.
    expect(screens.map((s) => s.route)).toEqual(
      [...screens.map((s) => s.route)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("extracts CSF stories with meta linkage", async () => {
    const { stories } = await analyzer.surfaces();
    expect(stories.map((s) => s.id)).toEqual([
      "src/views/Settings.stories.tsx#Primary",
      "src/views/Settings.stories.tsx#Compact",
    ]);
    expect(stories[0]).toMatchObject({
      title: "Views/Settings",
      name: "Primary",
      componentName: "Settings",
      componentFile: "src/views/Settings.tsx",
    });
  });

  it("lists exported components with usedBy, story and screen links", async () => {
    const { components } = await analyzer.surfaces();
    expect(components.map((c) => c.name)).toEqual(["Settings", "Home"]); // usedBy desc
    const settings = components[0]!;
    expect(settings).toMatchObject({
      file: "src/views/Settings.tsx",
      usedBy: 2, // router + stories file
      signature: "(props: { compact?: boolean })",
    });
    expect(settings.stories).toEqual([
      "src/views/Settings.stories.tsx#Primary",
      "src/views/Settings.stories.tsx#Compact",
    ]);
    expect(settings.screens).toEqual(["react-router:/app/settings"]);
    const home = components[1]!;
    expect(home.usedBy).toBe(1);
    expect(home.screens.sort()).toEqual(["react-router:/", "react-router:/app"]);
  });

  it("flattens served endpoints deduped by method+path", async () => {
    const { endpoints } = await analyzer.surfaces();
    expect(endpoints).toEqual([
      // First declaring file (sorted paths) wins the GET dup.
      { method: "GET", path: "/api/items", line: 1, handler: "dupHandler", file: "src/api/extra.ts" },
      { method: "POST", path: "/api/items", line: 5, handler: "createItem", file: "src/api/routes.ts" },
    ]);
  });

  it("collects zod, gated interface, and prisma schemas sorted by usedBy", async () => {
    const { schemas } = await analyzer.surfaces();
    expect(schemas.map((s) => [s.name, s.kind, s.usedBy])).toEqual([
      ["UserRow", "interface", 1],
      ["UserSchema", "zod", 1],
      ["Post", "prisma", 0],
    ]);
    const zod = schemas.find((s) => s.name === "UserSchema")!;
    expect(zod.fields).toEqual([
      { name: "id", type: "z.string().uuid()" },
      { name: "nickname", type: "z.string().optional()", optional: true },
    ]);
    const prisma = schemas.find((s) => s.kind === "prisma")!;
    expect(prisma.file).toBe("prisma/schema.prisma");
    expect(prisma.fields.map((f) => f.name)).toEqual(["id", "title", "body"]);
    // Ungated interfaces stay out.
    expect(schemas.find((s) => s.name === "NotASchema")).toBeUndefined();
  });

  it("detects demo targets from package.json scripts", async () => {
    const { demo, generatedAt } = await analyzer.surfaces();
    expect(demo).toEqual({
      appUrl: "http://localhost:4100",
      storybookUrl: "http://localhost:7007",
    });
    expect(generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("caches the report until invalidate()", async () => {
    const first = await analyzer.surfaces();
    expect(await analyzer.surfaces()).toBe(first);
    analyzer.invalidate();
    const second = await analyzer.surfaces();
    expect(second).not.toBe(first);
    expect(second.screens).toEqual(first.screens);
  });
});

describe("CodeMapAnalyzer.surfaces — next workspace", () => {
  let root: string;
  let analyzer: CodeMapAnalyzer;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-surfaces-next-"));
    await write(root, "package.json", JSON.stringify({ name: "nextfix", scripts: { dev: "next dev" } }));
    await write(root, "app/page.tsx", `export default function HomePage() { return <main />; }`);
    await write(
      root,
      "app/(marketing)/about/page.tsx",
      `export default function AboutPage() { return <div />; }`,
    );
    await write(
      root,
      "app/forms/[formId]/page.tsx",
      `export default function FormPage() { return <div />; }`,
    );
    await write(
      root,
      "app/docs/[...slug]/page.tsx",
      `export default function DocsPage() { return <div />; }`,
    );
    await write(root, "pages/legacy/[id].tsx", `export default function LegacyPage() { return <div />; }`);
    await write(root, "pages/_app.tsx", `export default function App() { return null; }`);
    await write(root, "pages/api/ping.tsx", `export default function handler() {}`);
    analyzer = new CodeMapAnalyzer(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("derives next-app and next-pages screens, skipping api/_app and convention", async () => {
    const { screens, endpoints, demo } = await analyzer.surfaces();
    expect(screens.map((s) => s.id).sort()).toEqual([
      "next-app:/",
      "next-app:/about",
      "next-app:/docs/*",
      "next-app:/forms/:formId",
      "next-pages:/legacy/:id",
    ]);
    const home = screens.find((s) => s.id === "next-app:/")!;
    expect(home).toMatchObject({ file: "app/page.tsx", component: "HomePage", line: 1 });
    expect(screens.some((s) => s.source === "convention")).toBe(false);
    // The pages/api file surfaces as an endpoint, not a screen.
    expect(endpoints).toEqual([{ method: "ALL", path: "/api/ping", file: "pages/api/ping.tsx" }]);
    expect(demo.appUrl).toBe("http://localhost:3000");
  });
});

describe("CodeMapAnalyzer.surfaces — convention fallback workspace", () => {
  let root: string;
  let analyzer: CodeMapAnalyzer;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-surfaces-conv-"));
    await write(root, "package.json", JSON.stringify({ name: "convfix" }));
    await write(root, "src/screens/UserProfile.tsx", `export const UserProfile = () => <div />;`);
    await write(root, "src/views/index.tsx", `export default function Root() { return <div />; }`);
    await write(root, "src/components/Button.tsx", `export const Button = () => <button />;`);
    await write(root, "src/screens/UserProfile.test.tsx", `export const Fake = () => <div />;`);
    analyzer = new CodeMapAnalyzer(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("falls back to convention screens from pages/screens/views dirs only", async () => {
    const { screens, demo } = await analyzer.surfaces();
    expect(screens.map((s) => s.id).sort()).toEqual([
      "convention:/",
      "convention:/user-profile",
    ]);
    expect(screens.find((s) => s.id === "convention:/user-profile")).toMatchObject({
      file: "src/screens/UserProfile.tsx",
      component: "UserProfile",
      source: "convention",
    });
    expect(screens.find((s) => s.id === "convention:/")).toMatchObject({
      file: "src/views/index.tsx",
      component: "Root",
    });
    // Button lives outside the convention dirs; the test file is excluded.
    expect(screens.some((s) => s.file === "src/components/Button.tsx")).toBe(false);
    expect(demo).toEqual({ appUrl: null, storybookUrl: null });
  });
});
