import path from "node:path";
import {
  CrossInfraOverlaySchema,
  createCrossInfraOverlay,
  type CrossInfraOverlay,
} from "@crystal/core";
import { JsonRecordStore } from "./record-store.js";

/**
 * Hub-scoped cross-infrastructure layout state. The record store provides
 * validation, serialized mutation, atomic persistence, and post-write notice.
 */
export class InfraOverlayStore {
  private readonly store: JsonRecordStore<CrossInfraOverlay>;

  constructor(
    hubRoot: string,
    onChanged: (overlay: CrossInfraOverlay) => void,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.store = new JsonRecordStore(
      path.join(hubRoot, "infra-overlays"),
      (raw) => CrossInfraOverlaySchema.parse(raw),
      onChanged,
      now,
    );
  }

  async get(): Promise<CrossInfraOverlay> {
    return (await this.store.get("default")) ?? createCrossInfraOverlay(this.now());
  }

  async save(overlay: CrossInfraOverlay): Promise<CrossInfraOverlay> {
    const validated = CrossInfraOverlaySchema.parse(overlay);
    await this.store.put({ ...validated, updatedAt: this.now() });
    return (await this.store.get("default"))!;
  }
}
