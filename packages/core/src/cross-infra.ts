import { z } from "zod";
import type { ArchEdgeKind, ArchNodeKind, TargetKind } from "./architecture.js";
import type { InfraZoneKind } from "./arch-deploy.js";

export interface CrossInfraEnvironment {
  id: string;
  name: string;
  kind: "local" | "cloud";
  targets: Array<{
    id: string;
    name: string;
    kind: TargetKind;
    tech?: string;
    region?: string;
    zoneId?: string;
    placedNodeIds: string[];
  }>;
  nodes: Array<{ id: string; label: string; kind: ArchNodeKind; targetId: string }>;
  edges: Array<{ id: string; source: string; target: string; kind: ArchEdgeKind; label: string }>;
  zones: Array<{ id: string; label: string; kind: InfraZoneKind; parentId?: string | null }>;
  externals: Array<{
    id: string;
    label: string;
    kind: ArchNodeKind;
    category?: string;
    clientNodeIds: string[];
  }>;
}

export interface CrossInfraMap {
  projects: Array<{
    ws: string;
    name: string;
    environments: CrossInfraEnvironment[];
    error?: string;
  }>;
  shared: Array<{
    key: string;
    label: string;
    kind: ArchNodeKind;
    category?: string;
    projects: Array<{ ws: string; envId: string; clientNodeIds: string[] }>;
  }>;
  generatedAt: string;
}

export const IdentityLinkMemberSchema = z.object({
  ws: z.string(),
  key: z.string(),
});
export const IdentityLinkSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  members: z.array(IdentityLinkMemberSchema),
});
export type IdentityLink = z.infer<typeof IdentityLinkSchema>;

export const CrossInfraOverlaySchema = z.object({
  id: z.literal("default"),
  createdAt: z.string(),
  updatedAt: z.string(),
  envSelection: z.record(z.string().nullable()).default({}),
  pins: z.record(z.object({ x: z.number(), y: z.number() })).default({}),
  identityLinks: z.array(IdentityLinkSchema).default([]),
});
export type CrossInfraOverlay = z.infer<typeof CrossInfraOverlaySchema>;

export function createCrossInfraOverlay(now = new Date().toISOString()): CrossInfraOverlay {
  return CrossInfraOverlaySchema.parse({ id: "default", createdAt: now, updatedAt: now });
}
