/**
 * Moved to @crystal/core (the C4 component tier derives from the same role
 * heuristics that band the live-code auto-layout). Re-exported here so
 * architect-internal imports keep working.
 */
export {
  type CodeRole,
  type ModuleFlavor,
  ROLE_BANDS,
  moduleFlavorOf,
  roleOfFile,
  roleRank,
} from "@crystal/core";
