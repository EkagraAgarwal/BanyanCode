/**
 * The **B · Trunk** Chat layout's public surface: the rail, the narrow-terminal
 * pill row, and the pure geometry the host needs (the width below which the
 * rail gives way to pills).
 */
export { TrunkPills, TrunkRail, TrunkSurface, branchGlyph, pillRank } from "./components/trunk/trunk"
export type { ChildState, MeshChild } from "./data/mesh"
export type { MeshLive } from "./data/live"
export type { MeshNode } from "./data/pending-rpc"
export {
  BRANCH_PULSE_SIGMA,
  BRANCH_PULSE_SPEED,
  branchDetail,
  branchLabelLayout,
  breathe,
  connectorCells,
  connectorRuns,
  dimProgress,
  labelOpacity,
  motionRemaining,
  orderBranches,
  TRUNK_CONNECTOR_CELLS,
  TRUNK_DIM_MS,
  TRUNK_FIRST_BRANCH_ROW,
  TRUNK_GROW_MS,
  TRUNK_LABEL_DELAY_MS,
  TRUNK_LABEL_FADE_MS,
  TRUNK_PULSE_SIGMA,
  TRUNK_PULSE_SPEED,
  TRUNK_RAIL_MIN_WIDTH,
  TRUNK_ROW_STEP,
  TRUNK_SETTLE_MS,
  trunkBranches,
  trunkCapacity,
  trunkLevel,
  trunkRows,
  type ConnectorRun,
  type TrunkBranch,
  type TrunkRow,
} from "./components/trunk/layout"
