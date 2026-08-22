import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchitectureGraph, ComposeSuggestionResult } from "@crystal/core";

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  result: null as ComposeSuggestionResult | null,
  setResult: vi.fn(),
  request: vi.fn(),
  subscribe: vi.fn<(event: string, handler: (payload: { ws: string; paths: string[] }) => void) => () => void>(() => vi.fn()),
  workspaceId: "ws-1",
}));

vi.mock("react", () => ({
  useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => { harness.effects.push(effect); },
  useMemo: <T,>(factory: () => T) => factory(),
  useRef: <T,>(value: T) => ({ current: value }),
  useState: vi.fn()
    .mockImplementationOnce(() => [harness.result, harness.setResult])
    .mockImplementationOnce(() => [true, vi.fn()])
    .mockImplementation(() => [false, vi.fn()]),
}));
vi.mock("@crystal/client", () => ({
  useCrystal: () => ({ client: { request: harness.request, events: { on: harness.subscribe } } }),
  useActiveWorkspace: () => ({ id: harness.workspaceId }),
}));

import { ComposeSuggestions } from "./ComposeSuggestions.js";
import { useState as mockedUseState } from "react";

const graph: ArchitectureGraph = { id: "g", name: "G", description: "", nodes: [], edges: [], environments: [], journeys: [], facets: [] };
const empty: ComposeSuggestionResult = { files: [], topology: [], suggestions: [], diagnostics: [] };

function configureState(result: ComposeSuggestionResult | null, collapsed = true, dismissed = false) {
  harness.result = result;
  const React = vi.mocked(mockedUseState);
  React.mockReset()
    .mockImplementationOnce(() => [result, harness.setResult] as never)
    .mockImplementationOnce(() => [collapsed, vi.fn()] as never)
    .mockImplementationOnce(() => [dismissed, vi.fn()] as never);
}

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (value && typeof value === "object" && "props" in value) return textOf((value as { props: { children?: unknown } }).props.children);
  return "";
}

describe("ComposeSuggestions", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    harness.effects.length = 0;
    harness.result = null;
    configureState(null);
    harness.request.mockResolvedValue(empty);
  });

  it("fetches lazily on mount and renders null while empty", async () => {
    expect(ComposeSuggestions({ graph, environment: null, onAdopt: vi.fn() })).toBeNull();
    expect(harness.request).not.toHaveBeenCalled();
    harness.effects[0]!();
    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.request).toHaveBeenCalledWith("infra.composeSuggest", {});
    await Promise.resolve();
    expect(harness.setResult).toHaveBeenCalledWith(empty);
  });

  it("debounces refetches only for the active workspace and compose basenames", () => {
    ComposeSuggestions({ graph, environment: null, onAdopt: vi.fn() });
    harness.effects[0]!();
    const handler = harness.subscribe.mock.calls[0]![1] as (event: { ws: string; paths: string[] }) => void;
    harness.request.mockClear();

    handler({ ws: "other", paths: ["compose.yml"] });
    handler({ ws: "ws-1", paths: ["src/config.yml"] });
    vi.advanceTimersByTime(250);
    expect(harness.request).not.toHaveBeenCalled();

    handler({ ws: "ws-1", paths: ["docker-compose.yml"] });
    vi.advanceTimersByTime(100);
    handler({ ws: "ws-1", paths: ["nested/compose.yaml"] });
    vi.advanceTimersByTime(199);
    expect(harness.request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(harness.request).toHaveBeenCalledOnce();
  });

  it("renders an expandable warning when every compose file failed", () => {
    configureState({
      files: ["compose.yml", "nested/compose.yaml"],
      topology: [],
      suggestions: [],
      diagnostics: [
        { path: "compose.yml", severity: "error", message: "bad YAML" },
        { path: "nested/compose.yaml", severity: "error", message: "services: Required" },
      ],
    }, false);

    const output = ComposeSuggestions({ graph, environment: null, onAdopt: vi.fn() });
    expect(textOf(output)).toContain("2 compose files could not be read");
    expect(textOf(output)).toContain("compose.yml: bad YAML");
    expect(textOf(output)).toContain("nested/compose.yaml: services: Required");
  });

  it("keeps parse diagnostics visible alongside valid suggestions", () => {
    configureState({
      files: ["compose.yml", "bad/compose.yml"],
      topology: [],
      suggestions: [{ key: "compose.yml:web", project: ".", path: "compose.yml", service: "web", image: "nginx", tech: "nginx", external: null, ports: [], volumes: [], networks: [], dependsOn: [], profiles: [] }],
      diagnostics: [{ path: "bad/compose.yml", severity: "error", message: "bad YAML" }],
    }, false);

    const output = ComposeSuggestions({ graph, environment: null, onAdopt: vi.fn() });
    expect(textOf(output)).toContain("Compose topology");
    expect(textOf(output)).toContain("web");
    expect(textOf(output)).toContain("bad/compose.yml: bad YAML");
  });
});
