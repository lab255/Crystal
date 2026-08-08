import { describe, expect, it } from "vitest";
// Dev-time-only imports of the server-side twin — the worker package stays
// dependency-free at runtime while any drift still fails this suite.
import type {
  HostToRelay as CoreHostToRelay,
  RelayToHost as CoreRelayToHost,
} from "../../../packages/core/src/publish.js";
import * as core from "../../../packages/core/src/publish.js";
import {
  HOST_TOKEN_MIN_LEN,
  INSTANCE_ID_RE,
  PUBLISH_PASSWORD_MIN_LEN,
  type HostToRelay,
  type RelayToHost,
} from "./protocol.js";

// Mutual assignability: if either copy gains/loses/changes an envelope
// variant, one of these aliases stops compiling.
type MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : never) : never;
const relayToHostLockstep: MutuallyAssignable<RelayToHost, CoreRelayToHost> = true;
const hostToRelayLockstep: MutuallyAssignable<HostToRelay, CoreHostToRelay> = true;

describe("relay protocol lockstep with @crystal/core publish.ts", () => {
  it("envelope unions are mutually assignable", () => {
    expect(relayToHostLockstep).toBe(true);
    expect(hostToRelayLockstep).toBe(true);
  });

  it("wire constants match the core twins", () => {
    expect(PUBLISH_PASSWORD_MIN_LEN).toBe(core.PUBLISH_PASSWORD_MIN_LEN);
    expect(HOST_TOKEN_MIN_LEN).toBe(core.HOST_TOKEN_MIN_LEN);
    expect(INSTANCE_ID_RE.source).toBe(core.INSTANCE_ID_RE.source);
    expect(INSTANCE_ID_RE.flags).toBe(core.INSTANCE_ID_RE.flags);
  });
});
