import type { PublishStatus } from "@crystal/core";

export const PUBLIC_LINK_COPIED_NOTICE = "public link copied";

export interface ShareLink {
  href: string;
  public: boolean;
}

/** Put the current Crystal view hash onto the relay's public client base. */
export function composePublicLink(publicBase: string, currentHash: string): string {
  const base = publicBase.replace(/#.*$/, "");
  if (!currentHash) return base;
  return `${base}${currentHash.startsWith("#") ? currentHash : `#${currentHash}`}`;
}

export function shareLinkFor(
  status: Pick<PublishStatus, "enabled" | "publicUrl"> | null,
  currentHref: string,
  currentHash: string,
): ShareLink {
  if (status?.enabled && status.publicUrl) {
    return { href: composePublicLink(status.publicUrl, currentHash), public: true };
  }
  return { href: currentHref, public: false };
}
