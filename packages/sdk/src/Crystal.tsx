import { CrystalProvider } from "@crystal/client";
import { CrystalShell, type CrystalShellProps } from "./CrystalShell.js";

export interface CrystalProps extends CrystalShellProps {
  /**
   * Bridge WebSocket URL (a running `@crystal/server`). Defaults to the
   * same-origin bridge when served over http(s) — `ws(s)://<host>/crystal`,
   * carrying a `?token=` when one is present — else the local desktop sidecar
   * (`ws://127.0.0.1:4517/crystal`).
   */
  url?: string;
}

/**
 * The full Crystal IDE as an embeddable React component.
 *
 * ```tsx
 * import { Crystal } from "@crystal/sdk";
 * import "@crystal/ui/styles.css";
 *
 * <div style={{ height: "100vh" }}>
 *   <Crystal initialMode="architect" />
 * </div>
 * ```
 */
export function Crystal({ url, ...shellProps }: CrystalProps) {
  return (
    <CrystalProvider url={url}>
      <CrystalShell {...shellProps} />
    </CrystalProvider>
  );
}
