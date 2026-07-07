/**
 * The context-menu overlay grew up in this package and moved to @crystal/ui so
 * other modes (editor file tree, code map) can use it; this shim keeps the
 * package-internal import path stable.
 */
export { ContextMenu, InlineRename, type MenuEntry } from "@crystal/ui";
