import { createRoot, type Root } from "react-dom/client";
import { Crystal, type CrystalProps } from "./Crystal.js";

export interface CrystalInstance {
  unmount(): void;
}

/**
 * Mount Crystal into any DOM element — for non-React hosts.
 *
 * ```ts
 * import { mountCrystal } from "@crystal/sdk";
 * const instance = mountCrystal(document.getElementById("crystal")!, { initialMode: "code" });
 * // later: instance.unmount();
 * ```
 */
export function mountCrystal(element: HTMLElement, props: CrystalProps = {}): CrystalInstance {
  const root: Root = createRoot(element);
  root.render(<Crystal {...props} />);
  return {
    unmount: () => root.unmount(),
  };
}
