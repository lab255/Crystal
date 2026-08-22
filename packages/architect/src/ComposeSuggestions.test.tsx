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
    .mockImplementation(() => [true, vi.fn()]),
}));
vi.mock("@crystal/client", () => ({
  useCrystal: () => ({ client: { request: harness.request, events: { on: harness.subscribe } } }),
  useActiveWorkspace: () => ({ id: harness.workspaceId }),
}));

import { ComposeSuggestions } from "./ComposeSuggestions.js";

const graph: ArchitectureGraph = { id: "g", name: "G", description: "", nodes: [], edges: [], environments: [], journeys: [], facets: [] };
const empty: ComposeSuggestionResult = { files: [], topology: [], suggestions: [], diagnostics: [] };

describe("ComposeSuggestions", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    harness.effects.length = 0;
    harness.result = null;
    const React = await import("react");
    vi.mocked(React.useState)
      .mockReset()
      .mockImplementationOnce(() => [harness.result, harness.setResult] as never)
      .mockImplementation(() => [true, vi.fn()] as never);
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
});
