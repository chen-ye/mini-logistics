/**
 * Shared Hourglass domain type schema for Mini Logistics.
 * Consumed strictly via comment-only JSDoc `@import { ... } from './types.js'`
 * so the browser makes zero runtime HTTP requests for `.d.ts` files.
 */

export type WorldSizeKey = "compact" | "standard" | "large" | "huge";
export type ArchetypeKey =
  "confluence" | "estuary" | "archipelago" | "inland" | "island-hopper";
export type TerrainAlgoKey =
  "tectonic-fbm" | "quilez-erosion" | "voronoi-plates";
export type HydrologyAlgoKey =
  "thalweg-astar" | "d8-strahler" | "meandering-plain";
export type AirportMixKey = "hub-regional" | "hub-reg-cargo" | "dual-hub";
export type ViewLayer =
  "aesthetic" | "rci" | "airport" | "hierarchy" | "hydrology" | "roadgrid";

export type WaterMaskCode = 0 | 1 | 2;
export type RoadGridCode = 0 | 1 | 2 | 3;
export type BuildingMaskCode = 0 | 1 | 2 | 3 | 4 | 5;

export interface WorldSizePreset {
  readonly W: number;
  readonly H: number;
  readonly tileSize: number;
  readonly label: string;
}

export interface GeneratorConfig {
  seed?: string;
  worldSize?: WorldSizeKey | (string & {});
  archetype?: ArchetypeKey | (string & {});
  terrainAlgo?: TerrainAlgoKey | (string & {});
  hydrologyAlgo?: HydrologyAlgoKey | (string & {});
  airportMix?: AirportMixKey | (string & {});
  includeIntermediateRamps?: boolean;
  waterCoverage?: number;
  townCount?: number;
  buildingDensity?: number;
  airportCount?: number;
  windAxis?: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface WindVector {
  x: number;
  y: number;
  angleDeg: number;
  rad?: number;
  label: string;
}

export interface DistrictColor {
  name: string;
  roof: string;
  base: string;
  pin: string;
  zone: string;
}

export interface Palette {
  bgPaper: string;
  gridLine: string;
  waterCyan: string;
  waterDeep: string;
  waterBankCream: string;
  urbanBlushPink: string;
  urbanLavenderZone: string;
  parkSageGreen: string;
  treeDots: string[];
  roadAsphalt: string;
  roadCasing: string;
  bridgeRail: string;
  motorwayFill: string;
  motorwayBorder: string;
  motorwayCore: string;
  shadowColor: string;
  districtColors: DistrictColor[];
}

export interface WaterBasin {
  id: number;
  size: number;
  cx: number;
  cy: number;
  deepX: number;
  deepY: number;
  minElev: number;
  touchesBorder: boolean;
}

export interface PrimarySink {
  id?: number;
  size?: number;
  cx?: number;
  cy?: number;
  deepX: number;
  deepY: number;
  minElev?: number;
  touchesBorder?: boolean;
}

export interface HydroFeature {
  x: number;
  y: number;
  type: "bay" | "lake" | "confluence";
}

export interface RiverPoint {
  x: number;
  y: number;
  width?: number;
}

export interface RiverRibbon {
  points: RiverPoint[];
  isMainOutflow: boolean;
  headwaterPt?: Point2D | null;
}

export interface Landmass {
  id: number;
  size: number;
  cx: number;
  cy: number;
}

export interface Borough {
  x: number;
  y: number;
  r?: number;
  radius?: number;
  strideX?: number;
  strideY?: number;
  phaseX?: number;
  phaseY?: number;
  isCore?: boolean;
  isMainCBD?: boolean;
}

export interface Town {
  id: number;
  clusterId: number;
  name: string;
  iata: string;
  x: number;
  y: number;
  tier: number;
  tierTitle: string;
  urbanRadius: number;
  effectiveR?: number;
  colorIdx: number;
  palette: DistrictColor;
  landmassId: number;
  suitabilityScore: number;
  parentId?: number | null;
  airportId: number | null;
  housesCount: number;
  destinationsCount: number;
  commercialCount: number;
  industrialCount: number;
  boroughs: Borough[];
  _seededInPhase1?: boolean;
}

export interface AirportDemandSchedule {
  arrivalRate: number;
  cargoShare: number;
  peakHour: number;
}

export interface Airport {
  id: number;
  name: string;
  iata: string;
  x: number;
  y: number;
  gx?: number;
  gy?: number;
  angleRad: number;
  runwayLabel: string;
  runwayCount: number;
  halfLen: number;
  halfWid: number;
  approachLen?: number;
  apronSide?: number;
  stubDist?: number;
  isHub: boolean;
  airportClass: "HUB" | "REG" | "CRG" | (string & {});
  classLabel: string;
  hostTownId: number;
  hostTownName: string;
  landmassId?: number;
  colorIdx: number;
  palette: DistrictColor;
  gateX: number;
  gateY: number;
  curbX: number;
  curbY: number;
  landNx: number;
  landNy: number;
  approachClearance: number;
  suitabilityScore: number;
  distToCBD: number;
  demandPins?: number;
  motorwayId?: number | null;
  landsideLoopPts?: Point2D[];
  accessStubPts?: Point2D[];
  demandSchedule?: AirportDemandSchedule;
  atc?: AirportATC;
  activeSign?: 1 | -1;
}

export interface RoadPoint {
  x: number;
  y: number;
  isBridge?: boolean;
}

export interface RoadSegment {
  points: RoadPoint[];
  type:
    "street" | "arterial" | "airport-loop" | "airport-spine" | (string & {});
  isMainBoulevard?: boolean;
  isUnderpassStem?: boolean;
  stubOriginX?: number;
  stubOriginY?: number;
  airportId?: number;
}

export interface House {
  id?: number;
  x: number;
  y: number;
  gx?: number;
  gy?: number;
  wScale?: number;
  hScale?: number;
  offX?: number;
  offY?: number;
  roadX: number;
  roadY: number;
  dirX?: number;
  dirY?: number;
  colorIdx: number;
  palette: DistrictColor;
  townId: number;
}

export interface FarmParcel {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  crop?: string;
  cropIdx?: number;
  furrowDir?: number;
  furrowAngle?: number;
  slotIdx?: number;
  spineAxis?: string;
  spineCoord?: number;
  meanElev?: number;
  meanSlope?: number;
  meanWater?: number;
  tiles: [number, number][];
  poly?: [number, number][];
}

export interface TractorTrack {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  isLeaf?: boolean;
}

export interface Destination {
  id: number;
  x: number;
  y: number;
  gx: number;
  gy: number;
  lotX?: number;
  lotY?: number;
  wTiles: number;
  hTiles: number;
  roadX: number;
  roadY: number;
  dirX?: number;
  dirY?: number;
  colorIdx: number;
  palette: DistrictColor;
  townId: number;
  townName?: string;
  label?: string;
  isCircular: boolean;
  hasUrgentPin?: boolean;
  pinsCount: number;
  demandPins?: number[];
  zoneType: "commercial" | "industrial";
  subType: "CBD" | "RET" | "RAW" | "MFG" | "LOG" | (string & {});
  resourceType?: "MINE" | "TIMBER" | "FARM" | null;
  isRuralNiche?: boolean;
  bspParcels?: FarmParcel[];
  estateLoops?: [number, number][][];
  tractorTracks?: TractorTrack[];
  windbreakPts?: [number, number][];
  estateBBox?: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface TreeDot {
  x: number;
  y: number;
  r: number;
  color: string;
}

export interface MotorwayTunnel {
  i0: number;
  i1: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  ang0: number;
  ang1: number;
}

export interface Motorway {
  id?: number;
  number: number;
  name?: string;
  fromTownId?: number | null;
  toTownId?: number | null;
  townId?: number | null;
  airportId?: number | null;
  sx: number;
  sy: number;
  ex: number;
  ey: number;
  waypoints: Point2D[];
  samples: Point2D[];
  tunnels?: MotorwayTunnel[];
  surfaceSpans?: Point2D[][];
  shieldPt?: Point2D;
  prunedStart?: boolean;
  prunedEnd?: boolean;
  isSpur?: boolean;
}

export interface DiamondSlipRamp {
  sySign: -1 | 1;
  sxSign: -1 | 1;
  isOffRamp: boolean;
  kRamp: number;
  p0: Point2D;
  p1: Point2D;
  p2: Point2D;
  p3: Point2D;
  gridX: number;
  gridY: number;
}

export interface CloverleafInterchange {
  type: "cloverleaf";
  x: number;
  y: number;
  angleA: number;
  angleB: number;
  activeSignsA: number[];
  activeSignsB: number[];
  prunedBridgeB: boolean;
  mwayA: number;
  mwayB: number;
  mwayMain?: number;
  mwaySpur?: number;
  townId?: number;
  townName?: string;
  isAirportStub?: boolean;
  airportId?: number;
  label?: string;
}

export interface TrumpetInterchange {
  type: "trumpet";
  x: number;
  y: number;
  angleMain: number;
  sideSign: number;
  mwayMain: number;
  mwaySpur: number;
  mwayA?: number;
  mwayB?: number;
  townId?: number;
  townName?: string;
  isAirportStub?: boolean;
  airportId?: number;
  label?: string;
}

export interface DiamondRampInterchange {
  type: "diamond-ramp";
  x: number;
  y: number;
  connSide: number;
  posTerm: Point2D;
  negTerm: Point2D;
  termX: number;
  termY: number;
  oppTermX: number;
  oppTermY: number;
  connectX: number;
  connectY: number;
  oppConnectX?: number;
  oppConnectY?: number;
  isThroughDiamond: boolean;
  ramps: DiamondSlipRamp[];
  angleRad: number;
  mwayNumber: number;
  townId?: number;
  townName: string;
  isAirportStub?: boolean;
  airportId?: number;
  label?: string;
}

export interface TerminalStubInterchange {
  type: "terminal-stub";
  isAirportStub: boolean;
  x: number;
  y: number;
  stubEndX: number;
  stubEndY: number;
  angleRad: number;
  airportId?: number;
  townId?: number;
  townName?: string;
  label?: string;
}

export type Interchange =
  | CloverleafInterchange
  | TrumpetInterchange
  | DiamondRampInterchange
  | TerminalStubInterchange;

export interface VehicleGraphEdge {
  to: number;
  cost: number;
}

export interface VehicleGraphNode {
  x: number;
  y: number;
  onMotorway: boolean;
  inTunnel: boolean;
  isStreet: boolean;
  isRoundabout: boolean;
  isSlipRamp?: boolean;
  onUpperBridge?: boolean;
}

export interface RoundaboutSpec {
  x: number;
  y: number;
  rTiles: number;
  rIsland?: number;
  accentColor?: string;
  isAirport?: boolean;
  isDiamondT?: boolean;
}

export interface DrivewaySpec {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RampGraphEdge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  isPortal?: boolean;
}

export interface RampGraphNode {
  x: number;
  y: number;
  isPortal?: boolean;
}

export interface RoadTopology {
  roadGrid?: Uint8Array;
  roadEdges?: Set<number>;
  bridgeCount?: number;
  vertexDeg: Uint8Array;
  edgeCount: number;
  streetTiles: number;
  arterialTiles: number;
  bridgeTiles: number;
  junctionCount: number;
  anomalies: RoadGraphAnomaly[];
}

export interface VehicleRoutingGraph {
  nodes: VehicleGraphNode[];
  adj: VehicleGraphEdge[][];
  tileToNode: Int32Array;
  numSurfaceNodes: number;
  roundabouts: RoundaboutSpec[];
  driveways?: DrivewaySpec[];
  rampEdges?: RampGraphEdge[];
  rampNodes?: RampGraphNode[];
  gScore: Float64Array;
  parent: Int32Array;
  seenGen: Int32Array;
  closedGen: Int32Array;
  gen: number;
}

export interface DirectedLanePoint {
  x: number;
  y: number;
  onMotorway?: boolean;
  inTunnel?: boolean;
  isBridge?: boolean;
  isStreet?: boolean;
  isDriveway?: boolean;
  isSlipRamp?: boolean;
  isRoundabout?: boolean;
  isRoundaboutArc?: boolean;
  onUpperBridge?: boolean;
}

export interface DirectedLaneTrack {
  pts: DirectedLanePoint[];
  cumLen: Float32Array;
  totalLength: number;
}

export interface CargoLink {
  from: Destination;
  to: Destination;
  stage:
    | "RAW->MFG"
    | "MFG->LOG"
    | "MFG->COM"
    | "LOG->COM"
    | "RAW->LOG"
    | (string & {});
  label: string;
  color: string;
  points: DirectedLanePoint[];
  usesMotorway: boolean;
  outboundTrack: DirectedLaneTrack;
  inboundTrack: DirectedLaneTrack;
}

export interface CommuterRoute {
  color: string;
  usesMotorway: boolean;
  outboundTrack: DirectedLaneTrack;
  inboundTrack: DirectedLaneTrack;
}

export interface Stage1WindState {
  windAngleIndex: number;
  windVector: Readonly<WindVector>;
  windLog: string;
}

export interface Stage2ATerrainState {
  worldSize: string;
  W: number;
  H: number;
  tileSize: number;
  elevationField: Float32Array;
  waterMask: Uint8Array;
  seaLevel: number;
  basins: WaterBasin[];
  primarySink: PrimarySink;
  hydroFeatures: HydroFeature[];
}

export interface Stage2BHydrologyState {
  hydroVersion: number;
  W: number;
  H: number;
  tileSize: number;
  elevationField: Float32Array;
  waterMask: Uint8Array;
  drainageField: Float32Array;
  rivers: RiverRibbon[];
  hydroFeatures: HydroFeature[];
  confluencePoint: Point2D | HydroFeature | null;
  seaLevel: number;
  hydroLog: string;
}

export interface Stage3SpatialState {
  slopeField: Float32Array;
  fertilityField: Float32Array;
  distToWater: Float32Array;
  urbanSuitability: Float32Array;
  landmassId: Int16Array;
  landmasses: Landmass[];
}

export interface Stage4SettlementsState {
  towns: Town[];
  clusters: Town[];
  settlementLog: string;
}

export interface Stage5AirportsState {
  airports: Airport[];
  towns: Town[];
  airportHeatmap: Float32Array;
  roadGrid: Uint8Array;
  buildingMask: Uint8Array;
  roads: RoadSegment[];
  airportLog: string;
}

export interface Stage67UrbanState {
  urbanVersion: number;
  towns: Town[];
  roadGrid: Uint8Array;
  buildingMask: Uint8Array;
  zoneColorIdx: Int8Array;
  roads: RoadSegment[];
  houses: House[];
  destinations: Destination[];
  trees: TreeDot[];
  bridgeCount: number;
  roadLog: string;
}

export interface Stage8MotorwaysState {
  towns: Town[];
  airports: Airport[];
  roadGrid: Uint8Array;
  buildingMask: Uint8Array;
  roads: RoadSegment[];
  houses: House[];
  destinations: Destination[];
  trees: TreeDot[];
  motorways: Motorway[];
  interchanges: Interchange[];
  displacedBuildingsCount: number;
}

export interface Stage9RampsAndCargoState {
  towns: Town[];
  airports: Airport[];
  roadGrid: Uint8Array;
  buildingMask: Uint8Array;
  roads: RoadSegment[];
  houses: House[];
  destinations: Destination[];
  trees: TreeDot[];
  motorways: Motorway[];
  interchanges: Interchange[];
  cargoLinks: CargoLink[];
  commuterRoutes: CommuterRoute[];
  roadTopology: RoadTopology;
  routingGraph: {
    roundabouts: RoundaboutSpec[];
    driveways?: DrivewaySpec[];
    rampEdges?: RampGraphEdge[];
    rampNodes?: RampGraphNode[];
  };
  displacedBuildingsCount: number;
  bridgeCount: number;
  rciCounts: { com: number; raw: number; mfg: number; log: number };
  mwayLog: string;
  cargoLog: string;
}

export interface CarAgent {
  isFreightTruck: boolean;
  isCargoLink: boolean;
  cargoStage?: string;
  outboundTrack: DirectedLaneTrack;
  inboundTrack: DirectedLaneTrack;
  returning: boolean;
  dist: number;
  segIdx: number;
  speed: number;
  color: string;
}

export type TownPalette = DistrictColor;

export type FlightPhase =
  "TAXI_OUT" | "TAKEOFF" | "CRUISE" | "LANDING" | "TAXI_IN" | "GATE_DWELL";

export interface FlightTrackPoint {
  x: number;
  y: number;
  altitude: number;
  phase: FlightPhase;
  speed: number;
}

export interface FlightAirwayCurve {
  sx: number;
  sy: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  ex: number;
  ey: number;
}

export interface FlightTrack {
  pts: FlightTrackPoint[];
  cumLen: Float32Array;
  totalLength: number;
  holdShortDist: number;
  airwayCurve: FlightAirwayCurve;
}

export interface PlaneEndpoint {
  id?: number;
  x: number;
  y: number;
  angleRad: number;
  halfLen: number;
  halfWid?: number;
  approachLen?: number;
  apronSide?: number;
  airportClass?: string;
  isHub?: boolean;
  palette?: TownPalette;
  atc?: AirportATC;
  activeSign?: 1 | -1;
}

export type PlaneFSMState =
  | "GATE_LOADING"
  | "PUSHBACK_HOLD"
  | "TAXI_TO_RUNWAY"
  | "HOLD_SHORT_QUEUE"
  | "TAKEOFF_ROLL"
  | "ENROUTE_CRUISE"
  | "APPROACH_QUEUE"
  | "LANDING_ROLLOUT"
  | "HOLD_CROSSING_RUNWAY"
  | "TAXI_TO_GATE";

export interface GateSlot {
  id: number;
  lx: number;
  ly: number;
  taxiY: number;
  taxiS: number;
  worldX: number;
  worldY: number;
  noseAngle: number;
  state: "FREE" | "RESERVED" | "OCCUPIED";
  occupiedBy: number | null;
  reservedBy: number | null;
}

export interface AirportATC {
  airportId: number;
  isHub: boolean;
  activeSign: 1 | -1;
  rwyLen: number;
  termW: number;
  taxiY: number;
  holdShortY: number;
  exitRwyX: number;
  crossTaxiX: number;
  depCrossX: number;
  holdShortS: number;
  preGateHoldS: number;
  gates: GateSlot[];
  taxiwayOccupants: PlaneAgent[];
  holdShortQueue: PlaneAgent[];
  crossingQueue: PlaneAgent[];
  approachQueue: PlaneAgent[];
  runwayBusyBy: number | null;
  depRunwayBusyBy: number | null;
  arrRunwayBusyBy: number | null;
  crossingBusyBy: number | null;
  lastOp: "ARRIVAL" | "DEPARTURE";
}

export interface PlaneAgent {
  id?: number;
  state?: PlaneFSMState;
  gateId?: number | null;
  reservedGateId?: number | null;
  taxiS?: number;
  targetTaxiS?: number;
  pushbackTimer?: number;
  holdingPatternAngle?: number;
  _resX?: number;
  _resY?: number;
  _resAng?: number;
  origin: Airport | PlaneEndpoint;
  dest: Airport | PlaneEndpoint;
  track: FlightTrack;
  dist: number;
  segIdx: number;
  phase: FlightPhase;
  altitude: number;
  x: number;
  y: number;
  ang: number;
  speed: number;
  dwellTimer: number;
  holdingShort: boolean;
  isCargoFreighter: boolean;
  color: string;
  progress: number;
}

export interface RoadGraphAnomaly {
  x: number;
  y: number;
  kind:
    "road-building-overlap" | "non-octilinear-edge" | "orphan-roadgrid-tile";
}

export interface RoadGraphDiagnostics {
  deg: Uint8Array;
  edgeCount: number;
  streetTiles: number;
  arterialTiles: number;
  bridgeTiles: number;
  junctionCount: number;
  rampEdgeCount: number;
  laneTrackCount: number;
  activeTracks?: number;
  rampTraversals?: number;
  roundaboutOrbits?: number;
  reversalAnomalies?: number;
  anomalies: RoadGraphAnomaly[];
}

export type InspectedEntity = Destination | Airport | Town;

export interface CameraTarget {
  readonly cx: number;
  readonly cy: number;
  readonly zoom: number;
}

export interface InspectedSelection {
  readonly type: "airport" | "building" | "town" | null;
  readonly id: number | null;
  readonly entity: InspectedEntity | null;
}

export interface ControlLabels {
  readonly waterLabel: string;
  readonly townsLabel: string;
  readonly densityLabel: string;
  readonly airportsLabel: string;
  readonly windLabel: string;
}

export interface AppState {
  readonly config: Readonly<Required<GeneratorConfig>>;
  readonly activeLayer: ViewLayer;
  readonly simSpeed: number;
  readonly drawerOpen: boolean;
  readonly camera: CameraTarget | null;
  readonly inspected: InspectedSelection;
}

declare global {
  interface Window {
    renderer: import("./renderer.js").MiniMotorwaysRenderer;
    currentWorld:
      import("./world-generator.js").ProceduralLogisticsWorld | null;
    simulator: import("./simulator.js").LogisticsSimulator | null;
    rebuildWorld: (
      preserveCamera?: boolean,
    ) => Promise<
      import("./world-generator.js").ProceduralLogisticsWorld | void
    >;
    openEntityInspector: (
      type: string,
      entity: InspectedEntity,
      shouldFocus?: boolean,
    ) => void;
    scheduler?: {
      yield: () => Promise<void>;
    };
  }
}
