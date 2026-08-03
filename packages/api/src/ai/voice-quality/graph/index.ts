export {
  FSM_NODES,
  CRITICAL_PATHS,
  criticalPathById,
  pathSmokeRequiredPaths,
  requiredPaths,
  type CriticalPath,
  type CriticalPathKind,
  type CoverageSource,
} from './paths';

export {
  computeGraphCoverage,
  coverageGatePasses,
  scriptCoversPathIds,
  groupByKind,
  DEFAULT_UNIT_COVERED_IDS,
  type GraphCoverageReport,
  type PathCoverageRow,
  type ComputeCoverageOptions,
} from './coverage';
