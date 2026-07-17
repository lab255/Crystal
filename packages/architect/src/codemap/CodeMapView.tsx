import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge as RfEdge,
  type Node as RfNode,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft,
  Boxes,
  ChevronRight,
  ClipboardCheck,
  Copy as CopyIcon,
  ExternalLink,
  FolderGit2,
  History,
  Layers,
  LayoutGrid,
  Package,
  Pin,
  RadioTower,
  Route,
  Rows3,
  Shrink,
  Sparkles,
  X,
} from "lucide-react";
import {
  CODE_LOD_LEVELS,
  conceptDisplayName,
  indexFacetVisibility,
  matchHighlight,
  parseLensTags,
  tagValue,
  type CodeFileDetail,
  type CodeIndex,
  type CodeLodLevel,
  type CodeMapLevelLink,
  type CodeMapSummary,
  type CodeModuleDetail,
  type CrossWorkspaceEdge,
  type CrossWorkspaceMap,
  type SystemOverview,
  type HighlightRef,
  type RefactorIntent,
} from "@crystal/core";
import {
  requestOpenFile,
  useCrystal,
  useNav,
  useNavUpdate,
  useSymbolMenu,
  useWorkspaces,
} from "@crystal/client";
import {
  Badge,
  Button,
  ContextMenu,
  EmptyState,
  Pane,
  Split,
  Spinner,
  Tooltip,
  cn,
  useContextMenu,
  type MenuEntry,
} from "@crystal/ui";
import { useRefactorIntents } from "../refactor-intents.js";
import { SymbolSnippet } from "../snippets.js";
import { hlClass, useViewHighlight } from "../use-highlight.js";
import { CodeNode, SYMBOL_DRAG_MIME, type CodeRfNode, type SymbolDragPayload } from "./CodeNode.js";
import { ChangesPanel } from "./ChangesPanel.js";
import { DuplicatesPanel } from "./DuplicatesPanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import {
  absolutePositionOf,
  accentFor,
  buildMapScene,
  codeKey,
  dropTargetAt,
  fileDropTargetAt,
  fileId,
  groupModulesByRepo,
  memberFootprint,
  moduleId,
  moduleOfPath,
  type DropTarget,
  type FileNodeData,
  type MapLens,
  type MapRfNode,
  type MapScene,
  type ModuleNodeData,
  type MoveLikeIntent,
  type SymbolNodeData,
} from "./map-model.js";
import { FacetsPanel } from "./FacetsPanel.js";
import { LodSlider } from "./LodSlider.js";
import { MapActionsContext, SYMBOL_TONES, mapNodeTypes, type MapActions } from "./map-nodes.js";

const crossNodeTypes = { code: CodeNode };

// The drill level is deep-linkable — core owns the shape.
type Level = CodeMapLevelLink;

/** dagre pass for the (flat) cross-workspace level. */
function layoutCross(nodes: CodeRfNode[], edges: RfEdge[]): CodeRfNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 120, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: 190, height: n.data.subtitle ? 52 : 40 });
  for (const e of edges) if (e.source !== e.target) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return { ...n, position: { x: pos.x - 95, y: pos.y - 20 } };
  });
}

/** Cross-view identity of a map node (see use-highlight.ts). */
function mapHlRef(data: MapRfNode["data"]): HighlightRef | null {
  if (data.nodeKind === "module") return { module: data.path, label: data.name };
  if (data.nodeKind === "file") return { file: data.path, module: data.module, label: data.name };
  if (data.nodeKind === "symbol")
    return { file: data.file, symbol: data.name, module: data.module, label: data.name };
  return null;
}

// requestOpenFile moved to @crystal/client so every mode can link into the
// editor; re-exported for the architect-internal imports of this module.
export { requestOpenFile };

export interface CodeMapViewProps {
  /** Start at this module instead of the workspace overview ("zoom in" entry). */
  initialModule?: string;
  /** Start at this file (within `initialModule`) — file-level "zoom in" entry. */
  initialFile?: string;
  /** Where the user came from (e.g. an architecture diagram) — rendered as a leading breadcrumb. */
  origin?: { label: string; onExit: () => void };
  /**
   * Clicking a workspace on the cross-workspace level hands off to the caller
   * (the unified canvas) instead of drilling into the standalone workspace map.
   */
  onEnterWorkspace?: (ws: string) => void;
  /** "Start journey here…" on a symbol — opens the journey dialog in Diagrams. */
  onStartJourney?: (seed: { file: string; symbol: string }) => void;
  /** "Show on the architecture diagram" — expands the node linked to the module. */
  onRevealInDiagram?: (module: string, file?: string) => void;
  /**
   * Path of the draft plan open in Diagrams, if any. Dropping a symbol on a
   * module/file records a move intent on it; without one, the first drop
   * auto-creates a draft (plan mode) and this is how the shell learns about it.
   */
  activeDraftPath?: string | null;
  /** A drop auto-created a draft — the shell should track it as the open draft. */
  onOpenDraft?: (path: string) => void;
}

export function CodeMapView(props: CodeMapViewProps = {}) {
  return (
    <ReactFlowProvider>
      <CodeMapInner {...props} />
    </ReactFlowProvider>
  );
}

const EMPTY_REFACTORS: RefactorIntent[] = [];
const EMPTY_LENS_FILES: ReadonlyMap<string, "all" | ReadonlySet<string>> = new Map();

interface CacheEntry<T> {
  gen: number;
  detail: T;
}

function CodeMapInner({
  initialModule,
  initialFile,
  origin,
  onEnterWorkspace,
  onStartJourney,
  onRevealInDiagram,
  activeDraftPath,
  onOpenDraft,
}: CodeMapViewProps) {
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const setActive = useWorkspaces((s) => s.setActive);

  // The drill level lives in the nav store so it deep-links and follows
  // back/forward. Null until we know the workspace to start from.
  const nav = useNavUpdate();
  const level = useNav((l) => l.architect?.codemap ?? null);
  const setLevelRaw = useCallback(
    (next: Level) => nav({ architect: { codemap: next } }),
    [nav],
  );
  const [summary, setSummary] = useState<CodeMapSummary | null>(null);
  const [cross, setCross] = useState<CrossWorkspaceMap | null>(null);
  const [crossEdge, setCrossEdge] = useState<CrossWorkspaceEdge | null>(null);
  const [loading, setLoading] = useState(true);
  const [pulse, setPulse] = useState(false);
  // Bumped by codemap.changed — every cached detail keyed below re-fetches.
  const [generation, setGeneration] = useState(0);

  const [moduleDetails, setModuleDetails] = useState<Map<string, CacheEntry<CodeModuleDetail>>>(
    () => new Map(),
  );
  const [fileDetails, setFileDetails] = useState<Map<string, CacheEntry<CodeFileDetail>>>(
    () => new Map(),
  );
  const [expandedModules, setExpandedModules] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [openCode, setOpenCode] = useState<ReadonlySet<string>>(() => new Set());
  const [modulePositions, setModulePositions] = useState<ReadonlyMap<string, { x: number; y: number }>>(
    () => new Map(),
  );
  // The selected file card rides the deep link next to the drill level, so
  // back/forward and shared links restore it.
  const selectedFile = useNav((l) => l.architect?.file ?? null);
  const setSelectedFile = useCallback(
    (path: string | null) => nav({ architect: { file: path } }),
    [nav],
  );
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const focusNonce = useRef(0);
  const inflight = useRef(new Set<string>());

  /* ---- level of detail + facet lens state ---- */

  const lodParam = useNav((l) => l.architect?.lod ?? null);
  const lod: CodeLodLevel = lodParam ?? "packages";
  const lensParam = useNav((l) => l.architect?.lens ?? null);
  const lensCtx = useNav((l) => l.architect?.lensCtx) ?? false;
  const [codeIndex, setCodeIndex] = useState<{ index: CodeIndex; staleFiles: string[] } | null>(
    null,
  );
  // Facets panel open state deep-links (same param as the systems overview).
  const showFacets = useNav((l) => l.architect?.facets) ?? false;
  // Generation for which the bulk (all modules + files) details are cached.
  const [bulkLoadedGen, setBulkLoadedGen] = useState(-1);
  const bulkData = useRef<{
    gen: number;
    modules: CodeModuleDetail[];
    files: CodeFileDetail[];
  } | null>(null);
  const bulkInflight = useRef<Promise<{
    modules: CodeModuleDetail[];
    files: CodeFileDetail[];
  } | null> | null>(null);
  const [refitNonce, setRefitNonce] = useState(0);
  const lodInit = useRef(false);
  const appliedLens = useRef<string | null>(null);
  // Active lens membership (dirs + files), mirrored into a ref so the detail
  // fetches (declared above the lens pipeline) can send it as `prefer` —
  // without it, module-file truncation can cut every lens member and the
  // drilled system renders as an empty shell.
  const lensPreferRef = useRef<string[] | null>(null);

  useEffect(() => {
    if (!level && activeWs) {
      setLevelRaw(
        initialFile
          ? { kind: "file", ws: activeWs, path: initialFile }
          : initialModule
            ? { kind: "module", ws: activeWs, path: initialModule }
            : { kind: "workspace", ws: activeWs },
      );
    }
  }, [level, activeWs, initialModule, initialFile, setLevelRaw]);

  const setLevel = useCallback(
    (next: Level) => {
      setCrossEdge(null);
      setLevelRaw(next);
    },
    [setLevelRaw],
  );

  const levelKind = level?.kind ?? null;
  const wsKey = level && level.kind !== "all" ? level.ws : null;
  const levelPath = level && (level.kind === "module" || level.kind === "file") ? level.path : null;

  // Reset the derived-map state when the browsed workspace actually changes.
  const lastWs = useRef<string | null>(null);
  useEffect(() => {
    if (!wsKey || lastWs.current === wsKey) return;
    const isSwitch = lastWs.current != null;
    lastWs.current = wsKey;
    setSummary(null);
    setModuleDetails(new Map());
    setFileDetails(new Map());
    setExpandedModules(new Set());
    setExpandedFiles(new Set());
    setOpenCode(new Set());
    setModulePositions(new Map());
    // Nav-held selection clears only on a real switch — on mount this
    // would erase a deep-linked file selection.
    if (isSwitch) setSelectedFile(null);
    setFocus(null);
    setCodeIndex(null);
    setBulkLoadedGen(-1);
    bulkData.current = null;
    lodInit.current = false;
    appliedLens.current = null;
  }, [wsKey, setSelectedFile]);

  /* ---- fetching ---- */

  useEffect(() => {
    if (!levelKind) return;
    let cancelled = false;
    setLoading(true);
    const run = async () => {
      try {
        if (levelKind === "all") setCross(await client.request("codemap.cross", {}));
        else if (wsKey) setSummary(await client.request("codemap.get", { ws: wsKey }));
      } catch {
        // Analyzer may briefly race a delete; the next codemap.changed refetches.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [client, levelKind === "all", wsKey, generation]);

  // On-demand module details for every expanded module (re-fetched per generation).
  useEffect(() => {
    if (!wsKey) return;
    for (const path of expandedModules) {
      if (moduleDetails.get(path)?.gen === generation) continue;
      const key = `${wsKey}|m|${path}|${generation}`;
      if (inflight.current.has(key)) continue;
      inflight.current.add(key);
      const prefer = lensPreferRef.current ?? undefined;
      client
        .request("codemap.module", { ws: wsKey, path, prefer })
        .then((detail) =>
          setModuleDetails((m) => new Map(m).set(path, { gen: generation, detail })),
        )
        .catch(() => {})
        .finally(() => inflight.current.delete(key));
    }
  }, [client, wsKey, expandedModules, generation, moduleDetails]);

  // File details: expanded files + the selected file + the drilled file.
  const wantedFiles = useMemo(() => {
    const set = new Set(expandedFiles);
    if (selectedFile) set.add(selectedFile);
    if (levelKind === "file" && levelPath) set.add(levelPath);
    return set;
  }, [expandedFiles, selectedFile, levelKind, levelPath]);

  useEffect(() => {
    if (!wsKey) return;
    for (const path of wantedFiles) {
      if (fileDetails.get(path)?.gen === generation) continue;
      const key = `${wsKey}|f|${path}|${generation}`;
      if (inflight.current.has(key)) continue;
      inflight.current.add(key);
      client
        .request("codemap.file", { ws: wsKey, path })
        .then((detail) => setFileDetails((m) => new Map(m).set(path, { gen: generation, detail })))
        .catch(() => {})
        .finally(() => inflight.current.delete(key));
    }
  }, [client, wsKey, wantedFiles, generation, fileDetails]);

  // Live updates: the server re-analyzes when code changes on disk.
  useEffect(() => {
    return client.events.on("codemap.changed", ({ ws }) => {
      if (level && level.kind !== "all" && ws !== level.ws) return;
      setPulse(true);
      setTimeout(() => setPulse(false), 1200);
      setGeneration((g) => g + 1);
    });
  }, [client, level]);

  // The open-workspace set changed — the cross map is stale.
  useEffect(() => {
    return client.events.on("workspaces.changed", () => {
      if (level?.kind === "all") setGeneration((g) => g + 1);
    });
  }, [client, level]);

  /* ---- level → expansion/focus (drilling zooms into the nested map) ---- */

  const levelKey = level ? `${level.kind}:${wsKey ?? ""}:${levelPath ?? ""}` : "";
  useEffect(() => {
    if (!level || !summary) return;
    if (level.kind === "module") {
      setExpandedModules((prev) => (prev.has(level.path) ? prev : new Set(prev).add(level.path)));
      setFocus({ id: moduleId(level.path), nonce: ++focusNonce.current });
    } else if (level.kind === "file") {
      const mod = moduleOfPath(level.path, summary.modules);
      setExpandedModules((prev) => (prev.has(mod) ? prev : new Set(prev).add(mod)));
      setExpandedFiles((prev) => (prev.has(level.path) ? prev : new Set(prev).add(level.path)));
      setSelectedFile(level.path);
      setFocus({ id: fileId(level.path), nonce: ++focusNonce.current });
    }
    // levelKey captures kind+ws+path; re-run once the summary is in.
  }, [levelKey, summary != null]);

  /* ---- bulk detail (LoD slider + lens member focus) ---- */

  const ensureBulk = useCallback(async () => {
    if (!wsKey) return null;
    if (bulkData.current?.gen === generation) return bulkData.current;
    bulkInflight.current ??= client
      .request("codemap.details", { ws: wsKey, prefer: lensPreferRef.current ?? undefined })
      .then((res) => {
        bulkData.current = { gen: generation, ...res };
        setModuleDetails((m) => {
          const next = new Map(m);
          for (const d of res.modules) next.set(d.module.path, { gen: generation, detail: d });
          return next;
        });
        setFileDetails((m) => {
          const next = new Map(m);
          for (const f of res.files) next.set(f.path, { gen: generation, detail: f });
          return next;
        });
        setBulkLoadedGen(generation);
        return bulkData.current;
      })
      .catch(() => null)
      .finally(() => {
        bulkInflight.current = null;
      });
    return bulkInflight.current;
  }, [client, wsKey, generation]);

  const applyLodExpansion = useCallback(
    async (next: CodeLodLevel) => {
      if (next === "repos" || next === "packages") {
        setExpandedModules(new Set());
        setExpandedFiles(new Set());
        setOpenCode(new Set());
        setSelectedFile(null);
      } else {
        const data = await ensureBulk();
        if (!data) return;
        setExpandedModules(new Set(data.modules.map((d) => d.module.path)));
        setExpandedFiles(next === "members" ? new Set(data.files.map((f) => f.path)) : new Set());
        if (next === "modules") setOpenCode(new Set());
      }
      setModulePositions(new Map());
      setRefitNonce((n) => n + 1);
    },
    [ensureBulk, setSelectedFile],
  );

  const setLod = useCallback(
    (next: CodeLodLevel) => {
      nav({ architect: { lod: next } });
      void applyLodExpansion(next);
    },
    [nav, applyLodExpansion],
  );

  // On reasonably sized workspaces the bulk details load eagerly, so member
  // badges and the members-level layout are ready before the slider moves.
  useEffect(() => {
    if (!summary || !wsKey || levelKind === "all") return;
    if (summary.fileTotal > 2000) return; // huge tree — fetch on demand only
    void ensureBulk();
  }, [summary, wsKey, levelKind, ensureBulk]);

  // A deep-linked level applies once the summary is in (unless a lens owns
  // the expansion — it focuses its own members).
  useEffect(() => {
    if (lodInit.current || !summary || !lodParam) return;
    lodInit.current = true;
    if (!lensParam) void applyLodExpansion(lodParam);
  }, [summary != null, lodParam, lensParam, applyLodExpansion]);

  // Keys 1–4 jump the LoD ladder (ignored while typing).
  useEffect(() => {
    if (!levelKind || levelKind === "all") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const i = ["1", "2", "3", "4"].indexOf(e.key);
      if (i !== -1) setLod(CODE_LOD_LEVELS[i]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [levelKind, setLod]);

  /* ---- code index + facet lens ---- */

  const lensTags = useMemo(() => (lensParam ? parseLensTags(lensParam) : []), [lensParam]);
  const lensKey = lensTags.join(",");
  // System lenses ("sys:auth" — a systems-overview cluster id) resolve
  // structurally against the overview; every other tag goes through the
  // semantic index (intent facets).
  const sysTags = useMemo(() => lensTags.filter((t) => t.startsWith("sys:")), [lensTags]);
  const intentTags = useMemo(() => lensTags.filter((t) => !t.startsWith("sys:")), [lensTags]);
  const wantIndex = showFacets || intentTags.length > 0;
  useEffect(() => {
    if (!wsKey || !wantIndex) return;
    let cancelled = false;
    const fetchIndex = () => {
      client
        .request("codeindex.get", { ws: wsKey })
        .then((res) => {
          if (!cancelled) setCodeIndex(res);
        })
        .catch(() => {});
    };
    fetchIndex();
    const dispose = client.events.on("codeindex.changed", ({ ws }) => {
      if (ws === wsKey) fetchIndex();
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [client, wsKey, wantIndex]);

  const lensVis = useMemo(
    () =>
      codeIndex && intentTags.length > 0 ? indexFacetVisibility(codeIndex.index, intentTags) : null,
    [codeIndex, intentTags],
  );
  // Overview backing the system lens — fetched only while a sys: tag is active.
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const wantOverview = sysTags.length > 0;
  useEffect(() => {
    if (!wsKey || !wantOverview) {
      setOverview(null);
      return;
    }
    let cancelled = false;
    client
      .request("codemap.overview", { ws: wsKey })
      .then((res) => {
        if (!cancelled) setOverview(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, wsKey, wantOverview, generation]);
  const lensSysModules = useMemo(
    () => (wantOverview && overview ? overview.systems.filter((s) => sysTags.includes(s.id)) : null),
    [wantOverview, overview, sysTags],
  );

  /** Combined lens membership: intent files/modules ∪ system parts (dirs). */
  const lensCore = useMemo(() => {
    const hasIntent = lensVis != null && lensVis.files.size > 0;
    const hasSys = lensSysModules != null && lensSysModules.length > 0;
    if (!hasIntent && !hasSys) return null;
    const modules = new Set<string>(hasIntent ? lensVis.modules : []);
    const dirs: string[] = [];
    let fileCount = hasIntent ? lensVis.fileCount : 0;
    for (const s of lensSysModules ?? []) {
      fileCount += s.fileCount;
      for (const p of s.parts) {
        modules.add(p.pkg);
        dirs.push(p.path);
      }
    }
    return {
      files: hasIntent ? lensVis.files : EMPTY_LENS_FILES,
      dirs,
      modules,
      fileCount,
      memberCount: hasIntent ? lensVis.memberCount : null,
    };
  }, [lensVis, lensSysModules]);

  // First-degree neighbors of the lens: modules outside it sharing an import
  // edge with a member — the "+N connected" context toggle's candidate set.
  const lensNeighbors = useMemo(() => {
    if (!lensCore || !summary) return null;
    const neighbors = new Set<string>();
    for (const d of summary.deps) {
      if (d.source === d.target) continue;
      const sourceIn = lensCore.modules.has(d.source);
      const targetIn = lensCore.modules.has(d.target);
      if (sourceIn && !targetIn) neighbors.add(d.target);
      else if (targetIn && !sourceIn) neighbors.add(d.source);
    }
    return neighbors;
  }, [lensCore, summary]);
  const mapLens = useMemo<MapLens | null>(
    () =>
      lensCore
        ? {
            files: lensCore.files,
            dirs: lensCore.dirs,
            modules: lensCore.modules,
            context:
              lensCtx && lensNeighbors && lensNeighbors.size > 0 ? lensNeighbors : undefined,
          }
        : null,
    [lensCore, lensCtx, lensNeighbors],
  );
  const lensName = useMemo(
    () =>
      lensTags
        .map((t) =>
          t.startsWith("intent:")
            ? conceptDisplayName(tagValue(t))
            : (overview?.systems.find((s) => s.id === t)?.name ?? t),
        )
        .join(" + "),
    [lensTags, overview],
  );

  // Lens membership → `prefer` on detail fetches (see lensPreferRef). When the
  // effective membership changes (lens entered/left, overview resolved), the
  // cached details were fetched with the wrong preference — drop them and
  // bump the generation so everything refetches lens-aware.
  const lensPrefer = useMemo(() => {
    if (!mapLens) return null;
    const list = [...(mapLens.dirs ?? []), ...mapLens.files.keys()];
    return list.length > 0 ? list : null;
  }, [mapLens]);
  lensPreferRef.current = lensPrefer;
  const lensSig = lensPrefer ? lensPrefer.join("\n") : "";
  const lastLensSig = useRef(lensSig);
  useEffect(() => {
    if (lastLensSig.current === lensSig) return;
    lastLensSig.current = lensSig;
    bulkData.current = null;
    bulkInflight.current = null;
    setBulkLoadedGen(-1);
    setModuleDetails(new Map());
    setGeneration((g) => g + 1);
  }, [lensSig]);

  // Entering a lens focuses the members that carry it; leaving restores the level.
  useEffect(() => {
    if (mapLens) {
      if (appliedLens.current === lensKey) return;
      appliedLens.current = lensKey;
      void ensureBulk();
      setExpandedModules(new Set(mapLens.modules));
      setExpandedFiles(new Set(mapLens.files.keys()));
      setSelectedFile(null);
      setModulePositions(new Map());
      setRefitNonce((n) => n + 1);
    } else if (appliedLens.current != null && lensTags.length === 0) {
      appliedLens.current = null;
      void applyLodExpansion(lod);
    }
  }, [mapLens, lensKey, lensTags.length, lod, ensureBulk, applyLodExpansion]);

  // Toggling the connected-context ring re-poses the lens scene — refit.
  const lastLensCtx = useRef(lensCtx);
  useEffect(() => {
    if (lastLensCtx.current === lensCtx) return;
    lastLensCtx.current = lensCtx;
    if (mapLens) setRefitNonce((n) => n + 1);
  }, [lensCtx, mapLens]);

  /* ---- drag-a-symbol refactor intents (plan mode) ---- */

  const { activeDraft, dropNotice, setDropNotice, recordMove, recordFileMove, recordHoist } =
    useRefactorIntents({ activeDraftPath, onOpenDraft });

  const showDuplicates = useNav((l) => l.architect?.duplicates) ?? false;
  const setShowDuplicates = useCallback(
    (on: boolean) => nav({ architect: { duplicates: on } }),
    [nav],
  );
  const showFindings = useNav((l) => l.architect?.findings) ?? false;
  const setShowFindings = useCallback(
    (on: boolean) => nav({ architect: { findings: on } }),
    [nav],
  );
  const showChanges = useNav((l) => l.architect?.changes) ?? false;
  const setShowChanges = useCallback(
    (on: boolean) => nav({ architect: { changes: on } }),
    [nav],
  );

  /* ---- cross-view highlight ---- */

  const { hover, hoverSource, pinned, setHover, pin } = useViewHighlight("codemap");
  const symbolMenu = useSymbolMenu();
  // Hovers this map published echo back through the store — only ring foreign ones.
  const externalHover = hoverSource !== "codemap" ? hover : null;

  /* ---- scenes ---- */

  const moduleDetailMap = useMemo(() => {
    const m = new Map<string, CodeModuleDetail>();
    for (const [k, v] of moduleDetails) m.set(k, v.detail);
    return m;
  }, [moduleDetails]);
  const fileDetailMap = useMemo(() => {
    const m = new Map<string, CodeFileDetail>();
    for (const [k, v] of fileDetails) m.set(k, v.detail);
    return m;
  }, [fileDetails]);

  const refactors = activeDraft?.draft.refactors ?? EMPTY_REFACTORS;
  const moves = useMemo(
    () => refactors.filter((r): r is MoveLikeIntent => r.kind === "move" || r.kind === "moveFile"),
    [refactors],
  );

  // Members-level footprints: once the bulk details are in, dagre lays every
  // module out at the size its fully exposed form needs, so the LoD slider
  // swaps detail without re-arranging the map. A lens compacts instead — it
  // exists to trim the canvas to one concern.
  const layoutSizes = useMemo(() => {
    if (bulkLoadedGen !== generation) return undefined;
    const sizes = new Map<string, { w: number; h: number }>();
    for (const [path, entry] of moduleDetails) {
      if (entry.gen !== generation) continue;
      sizes.set(
        path,
        memberFootprint(entry.detail, (p) => {
          const fd = fileDetails.get(p);
          return fd ? (fd.detail.symbols ?? fd.detail.exports).length : 0;
        }),
      );
    }
    return sizes;
  }, [bulkLoadedGen, generation, moduleDetails, fileDetails]);

  // Header badges: members per module (available once the bulk details are in).
  const memberCounts = useMemo(() => {
    if (bulkLoadedGen !== generation) return undefined;
    const counts = new Map<string, number>();
    for (const [path, entry] of moduleDetails) {
      if (entry.gen !== generation) continue;
      let n = 0;
      for (const f of entry.detail.files) {
        const fd = fileDetails.get(f.path);
        if (fd) n += (fd.detail.symbols ?? fd.detail.exports).length;
      }
      counts.set(path, n);
    }
    return counts;
  }, [bulkLoadedGen, generation, moduleDetails, fileDetails]);

  const scene = useMemo<MapScene | null>(() => {
    if (!summary || !level || level.kind === "all") return null;
    return buildMapScene({
      summary,
      moduleDetails: moduleDetailMap,
      fileDetails: fileDetailMap,
      expandedModules,
      expandedFiles,
      openCode,
      moves,
      selectedFile,
      focusId: focus?.id ?? null,
      positions: modulePositions,
      lens: mapLens,
      layoutSizes: mapLens ? undefined : layoutSizes,
      memberCounts,
    });
  }, [
    summary,
    level,
    moduleDetailMap,
    fileDetailMap,
    expandedModules,
    expandedFiles,
    openCode,
    moves,
    selectedFile,
    focus,
    modulePositions,
    mapLens,
    layoutSizes,
    memberCounts,
  ]);

  // The coarsest LoD stop: modules grouped by the repository versioning them.
  const repoScene = useMemo(() => {
    if (lod !== "repos" || !summary || !level || level.kind === "all") return null;
    const { repos, deps, repoOf } = groupModulesByRepo(summary);
    const visible = mapLens
      ? repos.filter((r) => [...mapLens.modules].some((m) => repoOf.get(m) === r.path))
      : repos;
    const visibleSet = new Set(visible.map((r) => r.path));
    const nodes: CodeRfNode[] = visible.map((r) => ({
      id: r.path,
      type: "code",
      position: { x: 0, y: 0 },
      data: {
        title: r.name,
        subtitle: r.path === "." ? "workspace repository" : r.path,
        accent: accentFor(r.path),
        icon: FolderGit2,
        badge: `${r.modules.length} pkg · ${r.fileCount} files`,
      },
    }));
    const edges: RfEdge[] = deps
      .filter((d) => visibleSet.has(d.source) && visibleSet.has(d.target))
      .map((d) => ({
        id: `r:${d.source}->${d.target}`,
        source: d.source,
        target: d.target,
        label: `${d.weight} imports`,
        style: {
          stroke: "var(--color-crystal-400)",
          strokeWidth: Math.min(1.2 + Math.log2(d.weight + 1), 4),
          opacity: 0.9,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: "var(--color-crystal-400)",
          width: 14,
          height: 14,
        },
        labelStyle: { fill: "var(--color-crystal-400)", fontSize: 9 },
        labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.9 },
      }));
    return { nodes: layoutCross(nodes, edges), edges };
  }, [lod, summary, level, mapLens]);

  // Entity counts per LoD stop, for the slider readout.
  const lodCounts = useMemo(() => {
    if (!summary) return undefined;
    const counts: Partial<Record<CodeLodLevel, number>> = {
      repos: groupModulesByRepo(summary).repos.length,
      packages: summary.modules.filter((m) => m.fileCount > 0).length,
      modules: summary.fileTotal,
    };
    const bd = bulkData.current;
    if (bulkLoadedGen === generation && bd) {
      counts.members = bd.files.reduce((n, f) => n + (f.symbols ?? f.exports).length, 0);
    }
    return counts;
  }, [summary, bulkLoadedGen, generation]);

  const crossScene = useMemo(() => {
    if (level?.kind !== "all" || !cross) return { nodes: [] as CodeRfNode[], edges: [] as RfEdge[] };
    const nodes: CodeRfNode[] = cross.workspaces.map((w) => ({
      id: w.id,
      type: "code",
      position: { x: 0, y: 0 },
      data: {
        title: w.name,
        subtitle: w.root,
        accent: accentFor(w.id),
        icon: Layers,
        badge: `${w.fileTotal} files`,
        emphasis: w.id === activeWs,
      },
    }));
    const edges: RfEdge[] = cross.edges.map((e) => ({
      id: `${e.source}->${e.target}`,
      source: e.source,
      target: e.target,
      label: `${e.packages.length} pkg / ${e.weight} imports`,
      style: {
        stroke: "var(--color-crystal-400)",
        strokeWidth: Math.min(1.2 + Math.log2(e.weight + 1), 4),
        opacity: 0.9,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-crystal-400)", width: 14, height: 14 },
      labelStyle: { fill: "var(--color-crystal-400)", fontSize: 9 },
      labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.9 },
    }));
    return { nodes: layoutCross(nodes, edges), edges };
  }, [level, cross, activeWs]);

  /* ---- interactions ---- */

  const moduleName = (p: string) =>
    summary?.modules.find((m) => m.path === p)?.name ?? (p === "." ? "(root)" : p);
  const wsName = (id: string) =>
    workspaces.find((w) => w.id === id)?.name ??
    cross?.workspaces.find((w) => w.id === id)?.name ??
    id;

  // Opening a file in the editor targets the active workspace — switch first
  // when the map is browsing a different one.
  const openInEditor = useCallback(
    (path: string, line?: number) => {
      if (wsKey && wsKey !== activeWs) setActive(wsKey);
      requestOpenFile(path, line);
    },
    [wsKey, activeWs, setActive],
  );

  const toggleModule = useCallback((path: string) => {
    setExpandedModules((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const toggleFile = useCallback((path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const toggleCode = useCallback((file: string, symbol: string) => {
    setOpenCode((prev) => {
      const next = new Set(prev);
      const key = codeKey(file, symbol);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const actions = useMemo<MapActions>(
    () => ({
      ws: wsKey ?? undefined,
      toggleModule,
      toggleFile,
      toggleCode,
      startJourney: onStartJourney,
      dropSymbol: (payload, target) => void recordMove(payload, target),
    }),
    [wsKey, toggleModule, toggleFile, toggleCode, onStartJourney, recordMove],
  );

  /**
   * Right-click menu of a map node: view-local drills on top, then the shared
   * cross-view block (`useSymbolMenu`) — the "codemap" group is omitted since
   * we *are* the code map.
   */
  const menuFor = useCallback(
    (data: MapRfNode["data"]): MenuEntry[] => {
      if (data.nodeKind === "module") {
        const d = data as ModuleNodeData;
        return [
          { type: "heading", label: d.name },
          {
            type: "item",
            label: "Drill into module",
            icon: Package,
            onSelect: () => wsKey && setLevel({ kind: "module", ws: wsKey, path: d.path }),
          },
          {
            type: "item",
            label: d.expanded ? "Collapse in place" : "Expand in place",
            icon: d.expanded ? Shrink : LayoutGrid,
            onSelect: () => toggleModule(d.path),
          },
          { type: "separator" },
          ...symbolMenu(
            { module: d.path, label: d.name },
            {
              omit: ["codemap"],
              revealOnDiagram: onRevealInDiagram ? () => onRevealInDiagram(d.path) : undefined,
            },
          ),
        ];
      }
      if (data.nodeKind === "file") {
        const d = data as FileNodeData;
        if (d.planned) return [];
        return [
          { type: "heading", label: d.name },
          {
            type: "item",
            label: "Drill into file",
            icon: FolderGit2,
            onSelect: () => wsKey && setLevel({ kind: "file", ws: wsKey, path: d.path }),
          },
          { type: "separator" },
          ...symbolMenu(
            { file: d.path, module: d.module, label: d.name },
            {
              omit: ["codemap"],
              openFile: openInEditor,
              revealOnDiagram: onRevealInDiagram
                ? () => onRevealInDiagram(d.module, d.path)
                : undefined,
            },
          ),
        ];
      }
      if (data.nodeKind === "symbol") {
        const d = data as SymbolNodeData;
        if (d.planned) return [];
        const journeyable = d.kind !== "reexport" && d.kind !== "default";
        return [
          { type: "heading", label: d.name },
          {
            type: "item",
            label: d.codeOpen ? "Hide source" : "Show source",
            icon: FolderGit2,
            onSelect: () => toggleCode(d.file, d.name),
          },
          { type: "separator" },
          ...symbolMenu(
            { file: d.file, symbol: d.name, module: d.module, label: d.name },
            {
              omit: ["codemap"],
              openFile: openInEditor,
              startJourney: onStartJourney && journeyable ? onStartJourney : undefined,
              revealOnDiagram: onRevealInDiagram
                ? () => onRevealInDiagram(d.module, d.file)
                : undefined,
            },
          ),
        ];
      }
      return [];
    },
    [wsKey, setLevel, toggleModule, toggleCode, openInEditor, onStartJourney, onRevealInDiagram, symbolMenu],
  );

  const onCrossNodeClick = useCallback(
    (_evt: unknown, node: CodeRfNode) => {
      if (onEnterWorkspace) onEnterWorkspace(node.id);
      else setLevel({ kind: "workspace", ws: node.id });
    },
    [setLevel, onEnterWorkspace],
  );
  const onCrossEdgeClick = useCallback(
    (_evt: unknown, edge: RfEdge) => {
      if (!cross) return;
      const hit = cross.edges.find((e) => `${e.source}->${e.target}` === edge.id);
      setCrossEdge(hit ?? null);
    },
    [cross],
  );

  const drilledFileDetail = levelKind === "file" && levelPath ? (fileDetailMap.get(levelPath) ?? null) : null;

  return (
    <MapActionsContext.Provider value={actions}>
    <div className="h-full min-h-0">
      <Split storageKey="architect:codemap" direction="horizontal">
        <Pane minSize="40%">
          <div className="relative h-full w-full min-w-0">
        <div className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-xl border border-edge bg-surface-2/95 px-2.5 py-1.5 text-xs shadow-xl shadow-black/30 backdrop-blur">
          {origin ? (
            <>
              <button
                type="button"
                className="flex items-center gap-1 font-semibold text-crystal-300 hover:text-crystal-200"
                onClick={origin.onExit}
                title="Back to the architecture diagram"
              >
                <Boxes className="h-3 w-3" />
                {origin.label}
              </button>
              <ChevronRight className="h-3 w-3 text-ink-faint" />
            </>
          ) : null}
          <button
            type="button"
            className={cn(
              "flex items-center gap-1 font-semibold",
              level?.kind === "all" ? "text-ink" : "text-ink-muted hover:text-ink",
            )}
            onClick={() => setLevel({ kind: "all" })}
            title="All open workspaces and their cross-imports"
          >
            <Layers className="h-3 w-3" />
            Workspaces
          </button>
          {level && level.kind !== "all" ? (
            <>
              <ChevronRight className="h-3 w-3 text-ink-faint" />
              <button
                type="button"
                className={cn(level.kind === "workspace" ? "text-ink" : "text-ink-muted hover:text-ink")}
                onClick={() => setLevel({ kind: "workspace", ws: level.ws })}
              >
                {wsName(level.ws)}
              </button>
            </>
          ) : null}
          {level && (level.kind === "module" || level.kind === "file") ? (
            <>
              <ChevronRight className="h-3 w-3 text-ink-faint" />
              <button
                type="button"
                className={cn(level.kind === "module" ? "text-ink" : "text-ink-muted hover:text-ink")}
                onClick={() =>
                  setLevel({
                    kind: "module",
                    ws: level.ws,
                    path:
                      level.kind === "module"
                        ? level.path
                        : moduleOfPath(level.path, summary?.modules ?? []),
                  })
                }
              >
                {moduleName(
                  level.kind === "module" ? level.path : moduleOfPath(level.path, summary?.modules ?? []),
                )}
              </button>
            </>
          ) : null}
          {level?.kind === "file" ? (
            <>
              <ChevronRight className="h-3 w-3 text-ink-faint" />
              <span className="text-ink">{level.path.split("/").pop()}</span>
            </>
          ) : null}
          <Tooltip content="Derived from source — updates automatically as code changes">
            <span className="ml-2 flex items-center gap-1 text-[10px] text-ink-faint">
              <RadioTower className={cn("h-3 w-3", pulse ? "animate-pulse text-ok" : "text-ok/60")} />
              live
            </span>
          </Tooltip>
          {level && level.kind !== "all" ? (
            <Tooltip content="Duplicated functions — identical implementations across the workspace">
              <button
                type="button"
                aria-pressed={showDuplicates}
                onClick={() => setShowDuplicates(!showDuplicates)}
                className={cn(
                  "ml-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
                  showDuplicates ? "bg-warn/15 text-warn" : "text-ink-faint hover:text-ink-muted",
                )}
              >
                <CopyIcon className="h-3 w-3" />
                dupes
              </button>
            </Tooltip>
          ) : null}
          {level && level.kind !== "all" ? (
            <Tooltip content="Review sweep — dead files, unused exports, duplicates, boundary leaks">
              <button
                type="button"
                aria-pressed={showFindings}
                onClick={() => setShowFindings(!showFindings)}
                className={cn(
                  "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
                  showFindings ? "bg-crystal-500/15 text-crystal-300" : "text-ink-faint hover:text-ink-muted",
                )}
              >
                <ClipboardCheck className="h-3 w-3" />
                review
              </button>
            </Tooltip>
          ) : null}
          {level && level.kind !== "all" ? (
            <Tooltip content="Recent changes — files touched lately, their wiring and blast radius (works without git)">
              <button
                type="button"
                aria-pressed={showChanges}
                onClick={() => setShowChanges(!showChanges)}
                className={cn(
                  "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
                  showChanges ? "bg-crystal-500/15 text-crystal-300" : "text-ink-faint hover:text-ink-muted",
                )}
              >
                <History className="h-3 w-3" />
                changes
              </button>
            </Tooltip>
          ) : null}
          {loading ? <Spinner className="ml-1 h-3 w-3" /> : null}
        </div>

        {level && level.kind !== "all" ? (
          <div className="absolute left-3 top-13 z-10 flex items-center gap-2 rounded-xl border border-edge bg-surface-2/95 px-2.5 py-1.5 text-xs shadow-xl shadow-black/30 backdrop-blur">
            <LodSlider level={lod} onChange={setLod} counts={lodCounts} />
            <span className="h-4 w-px bg-edge" />
            <Tooltip content="Facet lenses — focus the map on the members of one concern (authentication, payments, …)">
              <button
                type="button"
                aria-pressed={showFacets}
                onClick={() => nav({ architect: { facets: !showFacets } })}
                className={cn(
                  "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
                  showFacets ? "bg-crystal-500/15 text-crystal-300" : "text-ink-faint hover:text-ink-muted",
                )}
              >
                <Sparkles className="h-3 w-3" />
                facets
              </button>
            </Tooltip>
            {lensParam ? (
              <span className="flex items-center gap-1.5 rounded-md bg-crystal-500/15 px-1.5 py-0.5 text-[10px] text-crystal-300">
                <span className="max-w-40 truncate font-medium">{lensName}</span>
                {lensCore ? (
                  <span className="text-crystal-400/80">
                    {lensCore.memberCount != null ? `${lensCore.memberCount} members · ` : ""}
                    {lensCore.fileCount} files
                  </span>
                ) : (intentTags.length === 0 || codeIndex) && (sysTags.length === 0 || overview) ? (
                  <span className="text-warn">no matches</span>
                ) : (
                  <Spinner className="h-3 w-3" />
                )}
                {lensNeighbors && lensNeighbors.size > 0 ? (
                  <Tooltip content="Also show first-degree neighbor modules — collapsed and dimmed — with their edges into the facet">
                    <button
                      type="button"
                      aria-pressed={lensCtx}
                      onClick={() => nav({ architect: { lensCtx: !lensCtx } })}
                      className={cn(
                        "rounded px-1 py-0.5 transition-colors",
                        lensCtx
                          ? "bg-crystal-500/15 text-crystal-300"
                          : "text-ink-faint hover:text-ink-muted",
                      )}
                    >
                      +{lensNeighbors.size} connected
                    </button>
                  </Tooltip>
                ) : null}
                <button
                  type="button"
                  onClick={() => nav({ architect: { lens: null } })}
                  className="text-crystal-400 hover:text-crystal-200"
                  aria-label="Exit facet lens"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ) : null}
          </div>
        ) : null}

        {level?.kind === "all" && cross && cross.workspaces.length < 2 && !loading ? (
          <div className="absolute left-3 top-12 z-10 rounded-lg border border-edge bg-surface-2/95 px-2 py-1 text-[10px] text-ink-faint">
            Open another workspace (status bar picker) to see cross-workspace imports
          </div>
        ) : null}

        {dropNotice ? (
          <div className="absolute bottom-3 left-1/2 z-20 flex max-w-lg -translate-x-1/2 items-center gap-2 rounded-xl border border-warn/40 bg-surface-2/95 px-3 py-2 text-[11px] text-ink-muted shadow-xl shadow-black/30 backdrop-blur">
            <span className="min-w-0">{dropNotice}</span>
            <button
              type="button"
              onClick={() => setDropNotice(null)}
              className="shrink-0 text-ink-faint hover:text-ink"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        {level?.kind === "all" ? (
          crossScene.nodes.length === 0 && !loading ? (
            <EmptyState icon={FolderGit2} title="Nothing to map yet">
              No analyzable TypeScript/JavaScript found in the open workspaces.
            </EmptyState>
          ) : (
            <ReactFlow
              key="cross"
              nodes={crossScene.nodes}
              edges={crossScene.edges}
              nodeTypes={crossNodeTypes}
              onNodeClick={onCrossNodeClick}
              onEdgeClick={onCrossEdgeClick}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1.15 }}
              minZoom={0.08}
              maxZoom={2}
              nodesConnectable={false}
              panOnScroll
              proOptions={{ hideAttribution: true }}
              className="bg-surface-0"
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="var(--color-edge-strong)" />
              <Controls position="bottom-left" showInteractive={false} className="!rounded-lg !border !border-edge !bg-surface-2 !shadow-lg overflow-hidden" />
            </ReactFlow>
          )
        ) : repoScene ? (
          <ReactFlow
            key="repos"
            nodes={repoScene.nodes}
            edges={repoScene.edges}
            nodeTypes={crossNodeTypes}
            onNodeDoubleClick={() => setLod("packages")}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1.15 }}
            minZoom={0.08}
            maxZoom={2}
            nodesConnectable={false}
            panOnScroll
            proOptions={{ hideAttribution: true }}
            className="bg-surface-0"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="var(--color-edge-strong)" />
            <Controls position="bottom-left" showInteractive={false} className="!rounded-lg !border !border-edge !bg-surface-2 !shadow-lg overflow-hidden" />
            <Panel position="bottom-center" className="rounded-lg border border-edge bg-surface-2/95 px-2 py-1 text-[10px] text-ink-faint shadow-lg">
              Double-click a repository (or slide the detail knob) to open its packages
            </Panel>
          </ReactFlow>
        ) : scene && scene.nodes.length === 0 && !loading ? (
          mapLens ? (
            <EmptyState icon={Sparkles} title="Nothing matches this facet">
              No modules carry {lensName || "this facet"} — exit the lens or index more files.
            </EmptyState>
          ) : (
            <EmptyState icon={FolderGit2} title="Nothing to map yet">
              No analyzable TypeScript/JavaScript found in this workspace.
            </EmptyState>
          )
        ) : scene ? (
          <WorkspaceMapCanvas
            key={wsKey ?? "map"}
            scene={scene}
            refitNonce={refitNonce}
            focus={focus}
            menuFor={menuFor}
            externalHover={externalHover}
            pinned={pinned}
            onHoverNode={setHover}
            onPinNode={pin}
            onModuleMoved={(path, pos) =>
              setModulePositions((prev) => new Map(prev).set(path, pos))
            }
            onSymbolMoved={(payload, target) => void recordMove(payload, target)}
            onFileMoved={(fromFile, toModule) => void recordFileMove(fromFile, toModule)}
            onSelectFile={setSelectedFile}
            onDrillModule={(path) => wsKey && setLevel({ kind: "module", ws: wsKey, path })}
            onDrillFile={(path) => wsKey && setLevel({ kind: "file", ws: wsKey, path })}
            onRelayout={() => setModulePositions(new Map())}
            onCollapseAll={() => {
              setExpandedModules(new Set());
              setExpandedFiles(new Set());
              setOpenCode(new Set());
              setSelectedFile(null);
              if (lodParam === "modules" || lodParam === "members") {
                nav({ architect: { lod: "packages" } });
              }
            }}
          />
        ) : null}
      </div>
        </Pane>

        {level?.kind === "file" && drilledFileDetail ? (
          <Pane defaultSize={320} minSize={224} maxSize={560}>
            <FilePanel
              detail={drilledFileDetail}
              ws={level.ws}
              onNavigate={(p) => setLevel({ kind: "file", ws: level.ws, path: p })}
              onOpenFile={openInEditor}
              onStartJourney={onStartJourney}
              draftActive={activeDraft != null}
            />
          </Pane>
        ) : null}
        {level?.kind === "all" && crossEdge ? (
          <Pane defaultSize={320} minSize={224} maxSize={560}>
            <CrossEdgePanel
              edge={crossEdge}
              sourceName={wsName(crossEdge.source)}
              targetName={wsName(crossEdge.target)}
              onClose={() => setCrossEdge(null)}
            />
          </Pane>
        ) : null}
        {showDuplicates && level && level.kind !== "all" ? (
          <Pane defaultSize={384} minSize={260} maxSize={640}>
            <DuplicatesPanel
              ws={level.ws}
              moduleFilter={level.kind === "module" ? level.path : undefined}
              modules={summary?.modules ?? []}
              hasActiveDraft={activeDraft != null}
              onHoist={(intent) => void recordHoist(intent)}
              onClose={() => setShowDuplicates(false)}
            />
          </Pane>
        ) : null}
        {showFacets && level && level.kind !== "all" ? (
          <Pane defaultSize={320} minSize={240} maxSize={560}>
            <FacetsPanel
              index={codeIndex?.index ?? null}
              staleFiles={codeIndex?.staleFiles ?? []}
              activeTags={lensTags}
              onSelect={(s) => nav({ architect: { lens: s.tags.join(",") } })}
              onClear={() => nav({ architect: { lens: null } })}
              onClose={() => nav({ architect: { facets: null } })}
            />
          </Pane>
        ) : null}
        {showFindings && level && level.kind !== "all" ? (
          <Pane defaultSize={384} minSize={260} maxSize={640}>
            <ReviewPanel
              ws={level.ws}
              moduleFilter={level.kind === "module" ? level.path : undefined}
              onHoist={(intent) => void recordHoist(intent)}
              onOpenFile={openInEditor}
              onClose={() => setShowFindings(false)}
            />
          </Pane>
        ) : null}
        {showChanges && level && level.kind !== "all" ? (
          <Pane defaultSize={384} minSize={260} maxSize={640}>
            <ChangesPanel
              ws={level.ws}
              moduleFilter={level.kind === "module" ? level.path : undefined}
              onOpenFile={openInEditor}
              onClose={() => setShowChanges(false)}
            />
          </Pane>
        ) : null}
      </Split>
    </div>
    </MapActionsContext.Provider>
  );
}

/* ------------------------- nested workspace canvas ------------------------ */

const SNAP_STORAGE_KEY = "crystal:codemap:snap";

function WorkspaceMapCanvas({
  scene,
  refitNonce,
  focus,
  onModuleMoved,
  onSymbolMoved,
  onFileMoved,
  onSelectFile,
  onDrillModule,
  onDrillFile,
  onRelayout,
  onCollapseAll,
  menuFor,
  externalHover,
  pinned,
  onHoverNode,
  onPinNode,
}: {
  scene: MapScene;
  /** Bumped when the LoD level or facet lens re-poses the map — refit the viewport. */
  refitNonce?: number;
  focus: { id: string; nonce: number } | null;
  onModuleMoved: (path: string, pos: { x: number; y: number }) => void;
  onSymbolMoved: (payload: SymbolDragPayload, target: DropTarget) => void;
  onFileMoved: (fromFile: string, toModule: string) => void;
  onSelectFile: (path: string | null) => void;
  onDrillModule: (path: string) => void;
  onDrillFile: (path: string) => void;
  onRelayout: () => void;
  onCollapseAll: () => void;
  /** Entries for a node's right-click menu (empty array = no menu). */
  menuFor?: (data: MapRfNode["data"]) => MenuEntry[];
  /** Cross-view hover published by another surface (own echoes filtered out). */
  externalHover: HighlightRef | null;
  /** Deep-linked pinned highlight (`sel` param). */
  pinned: HighlightRef | null;
  /** Publish (`ref`) or clear (`null`) this map's hover. */
  onHoverNode: (ref: HighlightRef | null) => void;
  /** Pin a highlight into the deep link, or clear it with `null`. */
  onPinNode: (ref: HighlightRef | null) => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<MapRfNode>(scene.nodes);
  const [snap, setSnap] = useState(() => {
    try {
      return localStorage.getItem(SNAP_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleSnap = useCallback(() => {
    setSnap((s) => {
      try {
        localStorage.setItem(SNAP_STORAGE_KEY, s ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !s;
    });
  }, []);

  useEffect(() => {
    setNodes(scene.nodes);
  }, [scene, setNodes]);

  // Drill targets zoom into view once their node exists (details may lag).
  const { fitView } = useReactFlow();

  // LoD/lens re-poses land as a whole-scene refit (skipped on first render —
  // the initial fitView prop already frames the map).
  const lastRefit = useRef(refitNonce ?? 0);
  useEffect(() => {
    if (refitNonce == null || refitNonce === lastRefit.current) return;
    lastRefit.current = refitNonce;
    const t = setTimeout(() => {
      void fitView({ padding: 0.15, duration: 450 });
    }, 80);
    return () => clearTimeout(t);
  }, [refitNonce, fitView]);
  const focusReady = focus != null && scene.nodes.some((n) => n.id === focus.id);
  useEffect(() => {
    if (!focus || !focusReady) return;
    const t = setTimeout(() => {
      void fitView({ nodes: [{ id: focus.id }], padding: 0.35, duration: 450, maxZoom: 1.15 });
    }, 60);
    return () => clearTimeout(t);
  }, [focus?.nonce, focusReady, fitView]);

  const onNodeDragStop = useCallback(
    (_evt: unknown, node: RfNode) => {
      const data = node.data as MapRfNode["data"];
      if (data.nodeKind === "module") {
        onModuleMoved((data as ModuleNodeData).path, node.position);
        return;
      }
      const abs = absolutePositionOf(nodes, node.id);
      const center = abs
        ? { x: abs.x + (node.width ?? 0) / 2, y: abs.y + (node.height ?? 0) / 2 }
        : null;
      if (data.nodeKind === "symbol") {
        const d = data as SymbolNodeData;
        if (center && !d.planned) {
          const target = dropTargetAt(nodes, center, { file: d.file, module: d.module });
          if (target) onSymbolMoved({ file: d.file, symbol: d.name }, target);
        }
      } else if (data.nodeKind === "file") {
        const d = data as FileNodeData;
        if (center && !d.planned) {
          const target = fileDropTargetAt(nodes, center, d.path, d.module);
          if (target) onFileMoved(d.path, target.module);
        }
      }
      // The node's real home is derived — snap it back (planned ghosts render
      // in the target once the intent lands on the draft).
      setNodes(scene.nodes);
    },
    [nodes, scene, setNodes, onModuleMoved, onSymbolMoved, onFileMoved],
  );

  const onNodeClick = useCallback(
    (_evt: unknown, node: RfNode) => {
      const data = node.data as MapRfNode["data"];
      if (data.nodeKind === "file") onSelectFile((data as FileNodeData).path);
      const el = mapHlRef(data);
      if (el) onPinNode(el);
    },
    [onSelectFile, onPinNode],
  );

  const onNodeMouseEnter = useCallback(
    (_evt: unknown, node: RfNode) => {
      const el = mapHlRef(node.data as MapRfNode["data"]);
      if (el) onHoverNode(el);
    },
    [onHoverNode],
  );
  const onNodeMouseLeave = useCallback(() => onHoverNode(null), [onHoverNode]);

  // Cross-view highlight: ring nodes matching the hover published by another
  // surface or the deep-linked pinned selection (kin = same lineage).
  const displayNodes = useMemo(() => {
    if (!externalHover && !pinned) return nodes;
    return nodes.map((n) => {
      const el = mapHlRef(n.data);
      if (!el) return n;
      const cls = hlClass(matchHighlight(externalHover, el), matchHighlight(pinned, el));
      return cls ? { ...n, className: cn(n.className, cls) } : n;
    });
  }, [nodes, externalHover, pinned]);

  const onNodeDoubleClick = useCallback(
    (_evt: unknown, node: RfNode) => {
      const data = node.data as MapRfNode["data"];
      if (data.nodeKind === "module") onDrillModule((data as ModuleNodeData).path);
      else if (data.nodeKind === "file") onDrillFile((data as FileNodeData).path);
    },
    [onDrillModule, onDrillFile],
  );

  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const onNodeContextMenu = useCallback(
    (evt: React.MouseEvent, node: RfNode) => {
      if (!menuFor) return;
      const entries = menuFor(node.data as MapRfNode["data"]);
      if (entries.length === 0) return;
      evt.preventDefault();
      setMenu({ x: evt.clientX, y: evt.clientY, entries });
    },
    [menuFor],
  );

  return (
    <>
    <ReactFlow
      nodes={displayNodes}
      edges={scene.edges}
      nodeTypes={mapNodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onNodeContextMenu={onNodeContextMenu}
      onNodeMouseEnter={onNodeMouseEnter}
      onNodeMouseLeave={onNodeMouseLeave}
      onPaneClick={() => {
        onSelectFile(null);
        onPinNode(null);
      }}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.05}
      maxZoom={2}
      nodesConnectable={false}
      panOnScroll
      snapToGrid={snap}
      snapGrid={[16, 16]}
      proOptions={{ hideAttribution: true }}
      className="bg-surface-0"
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="var(--color-edge-strong)" />
      <Controls position="bottom-left" showInteractive={false} className="!rounded-lg !border !border-edge !bg-surface-2 !shadow-lg overflow-hidden" />
      <MiniMap
        position="bottom-right"
        pannable
        zoomable
        className="!h-28 !w-40 !rounded-lg !border !border-edge !bg-surface-2"
        nodeColor={(n) =>
          (n.data as MapRfNode["data"]).nodeKind === "module"
            ? "var(--color-surface-3)"
            : "var(--color-crystal-500)"
        }
        maskColor="color-mix(in srgb, var(--color-surface-0) 75%, transparent)"
      />
      <Panel position="top-right" className="flex items-center gap-0.5 rounded-xl border border-edge bg-surface-2/95 p-1 shadow-xl shadow-black/30 backdrop-blur">
        <Tooltip content={snap ? "Snap to grid: on" : "Snap to grid: off"}>
          <button
            type="button"
            aria-pressed={snap}
            onClick={toggleSnap}
            className={cn(
              "rounded-lg p-1.5 transition-colors",
              snap ? "bg-crystal-500/15 text-crystal-300" : "text-ink-faint hover:text-ink",
            )}
            aria-label="Toggle snap to grid"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <Tooltip content="Re-layout — clear manual positions and pack everything neatly">
          <button
            type="button"
            onClick={onRelayout}
            className="rounded-lg p-1.5 text-ink-faint transition-colors hover:text-ink"
            aria-label="Auto-layout"
          >
            <Rows3 className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <Tooltip content="Collapse everything back to modules">
          <button
            type="button"
            onClick={onCollapseAll}
            className="rounded-lg p-1.5 text-ink-faint transition-colors hover:text-ink"
            aria-label="Collapse all"
          >
            <Shrink className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </Panel>
    </ReactFlow>
    {menu ? (
      <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
    ) : null}
    </>
  );
}

/** Package-level breakdown of one workspace-pair import edge. */
function CrossEdgePanel({
  edge,
  sourceName,
  targetName,
  onClose,
}: {
  edge: CrossWorkspaceEdge;
  sourceName: string;
  targetName: string;
  onClose: () => void;
}) {
  return (
    <aside className="flex h-full w-full flex-col bg-surface-1">
      <div className="border-b border-edge px-3 py-2.5">
        <div className="flex items-center gap-2">
          <ArrowRightLeft className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
          <div className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
            {sourceName} <span className="text-ink-faint">imports from</span> {targetName}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close panel">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="mt-0.5 text-[10px] text-ink-faint">
          {edge.weight} import{edge.weight !== 1 ? "s" : ""} across {edge.packages.length} package
          {edge.packages.length !== 1 ? "s" : ""}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {edge.packages.map((pkg) => (
          <div key={pkg.pkg}>
            <div className="flex items-center gap-2">
              <Package className="h-3 w-3 shrink-0 text-crystal-300" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">{pkg.pkg}</span>
              <Badge tone="cyan">{pkg.count}×</Badge>
            </div>
            <div className="mb-1 mt-0.5 pl-5 text-[9.5px] text-ink-faint">
              exported by <span className="font-mono">{pkg.toModule}</span>
            </div>
            <div className="space-y-1 pl-5">
              {pkg.uses.map((use) => (
                <div key={use.fromModule} className="rounded-lg border border-edge bg-surface-2 px-2 py-1">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-muted">
                      {use.fromModule}
                    </span>
                    <span className="shrink-0 text-[9px] text-ink-faint">{use.count}×</span>
                  </div>
                  {use.names.length > 0 ? (
                    <div className="mt-0.5 truncate text-[9.5px] text-prism-400" title={use.names.join(", ")}>
                      {use.names.join(", ")}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
        {edge.packages.length === 0 ? (
          <div className="py-2 text-[11px] text-ink-faint">No package-level detail</div>
        ) : null}
      </div>
    </aside>
  );
}

function FilePanel({
  detail,
  ws,
  onNavigate,
  onOpenFile,
  onStartJourney,
  draftActive,
}: {
  detail: CodeFileDetail;
  ws?: string;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  onStartJourney?: (seed: { file: string; symbol: string }) => void;
  /** A draft plan is open — moves land on it instead of starting a new one. */
  draftActive?: boolean;
}) {
  const externals = detail.imports.filter((i) => i.external);
  const internals = detail.imports.filter((i) => i.resolved);
  const [expanded, setExpanded] = useState<string | null>(null);
  const menu = useContextMenu();
  const symbolMenu = useSymbolMenu();
  // Older servers don't send `symbols`; fall back to the export list.
  const symbols = detail.symbols ?? detail.exports;

  return (
    <aside className="flex h-full w-full flex-col bg-surface-1">
      <div className="border-b border-edge px-3 py-2.5">
        <div className="truncate text-xs font-semibold text-ink">{detail.path}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-ink-faint">
          <span>{detail.loc} lines</span>
          <span>{detail.exports.length} exports</span>
          <span>{detail.imports.length} imports</span>
        </div>
        <Button
          variant="secondary"
          size="xs"
          className="mt-2"
          onClick={() => onOpenFile(detail.path)}
        >
          <ExternalLink className="h-3 w-3" /> Open in editor
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <Section title={`Symbols (${symbols.length})`}>
          <div className="mb-1.5 rounded-lg border border-edge bg-surface-2 px-2 py-1 text-[10px] text-ink-faint">
            {draftActive
              ? "Draft plan active — drag a symbol onto a file or module node to plan a move."
              : "Drag a symbol onto a file or module node to start a refactor plan."}
          </div>
          {symbols.map((sym, i) => (
            <div key={`${sym.name}${i}`}>
              <div
                className={cn(
                  "flex items-center gap-1.5 py-0.5 text-[11.5px]",
                  sym.kind !== "reexport" && "cursor-grab active:cursor-grabbing",
                )}
                draggable={sym.kind !== "reexport"}
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    SYMBOL_DRAG_MIME,
                    JSON.stringify({ file: detail.path, symbol: sym.name }),
                  );
                  e.dataTransfer.effectAllowed = "move";
                }}
                onContextMenu={(e) =>
                  menu.open(e, [
                    { type: "heading", label: sym.name },
                    {
                      type: "item",
                      label: expanded === sym.name ? "Hide source" : "Show source",
                      icon: FolderGit2,
                      onSelect: () => setExpanded(expanded === sym.name ? null : sym.name),
                    },
                    { type: "separator" },
                    ...symbolMenu(
                      {
                        file: detail.path,
                        symbol: sym.name,
                        module: detail.module,
                        line: sym.line,
                        label: sym.name,
                      },
                      {
                        omit: ["codemap"],
                        openFile: onOpenFile,
                        startJourney:
                          onStartJourney && sym.kind !== "reexport" && sym.kind !== "default"
                            ? onStartJourney
                            : undefined,
                      },
                    ),
                  ])
                }
              >
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === sym.name ? null : sym.name)}
                  className="shrink-0 rounded p-0.5 text-ink-faint hover:text-ink"
                  aria-label={`${expanded === sym.name ? "Hide" : "Show"} source of ${sym.name}`}
                >
                  <ChevronRight
                    className={cn("h-3 w-3 transition-transform", expanded === sym.name && "rotate-90")}
                  />
                </button>
                <Badge tone={SYMBOL_TONES[sym.kind].tone} className="w-8 justify-center font-mono">
                  {SYMBOL_TONES[sym.kind].label}
                </Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-ink">{sym.name}</span>
                {sym.exported === false ? <Badge tone="neutral">int</Badge> : null}
                {onStartJourney && sym.kind !== "reexport" && sym.kind !== "default" ? (
                  <Tooltip content="Start journey here — trace this symbol's dataflow on the diagram">
                    <button
                      type="button"
                      onClick={() => onStartJourney({ file: detail.path, symbol: sym.name })}
                      className="shrink-0 rounded p-0.5 text-ink-faint hover:text-crystal-300"
                      aria-label={`Start journey at ${sym.name}`}
                    >
                      <Route className="h-3 w-3" />
                    </button>
                  </Tooltip>
                ) : null}
                <span className="text-[9px] text-ink-faint">:{sym.line}</span>
              </div>
              {expanded === sym.name ? (
                <SymbolSnippet file={detail.path} symbol={sym.name} ws={ws} className="mb-1.5 ml-5" />
              ) : null}
            </div>
          ))}
          {symbols.length === 0 ? <Empty label="No top-level symbols" /> : null}
        </Section>
        <Section title={`Imports — internal (${internals.length})`}>
          {internals.map((imp, i) => (
            <button
              key={i}
              type="button"
              onClick={() => imp.resolved && onNavigate(imp.resolved)}
              className="block w-full truncate py-0.5 text-left font-mono text-[11px] text-prism-400 hover:underline"
              title={imp.names.join(", ")}
            >
              {imp.resolved}
            </button>
          ))}
          {internals.length === 0 ? <Empty label="None" /> : null}
        </Section>
        <Section title={`Imports — external (${externals.length})`}>
          {externals.map((imp, i) => (
            <div key={i} className="truncate py-0.5 font-mono text-[11px] text-ink-muted" title={imp.names.join(", ")}>
              {imp.specifier}
            </div>
          ))}
          {externals.length === 0 ? <Empty label="None" /> : null}
        </Section>
        <Section title={`Imported by (${detail.importedBy.length})`}>
          {detail.importedBy.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onNavigate(p)}
              className="block w-full truncate py-0.5 text-left font-mono text-[11px] text-prism-400 hover:underline"
            >
              {p}
            </button>
          ))}
          {detail.importedBy.length === 0 ? <Empty label="Nothing imports this file" /> : null}
        </Section>
      </div>
      {menu.element}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{title}</div>
      {children}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <div className="py-0.5 text-[11px] text-ink-faint">{label}</div>;
}
