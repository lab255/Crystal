import { CrystalProvider } from "@crystal/client";
import { CrystalShell, type CrystalShellProps } from "./CrystalShell.js";

export interface CrystalProps extends CrystalShellProps {
  /**
   * Bridge WebSocket URL (a running `@crystal/server`).
   * Defaults to `ws://<host>:4517/crystal`.
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
