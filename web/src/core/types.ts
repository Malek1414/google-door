// Types mirroring docs/CONTRACT.md v1. Do not add fields here that the contract lacks.

export type Tier = 0 | 1 | 2 | 3
export type Confidence = 'surveyed' | 'reported' | 'community' | 'unknown'
export type EntranceKind = 'main' | 'yes' | 'secondary' | 'service' | 'emergency' | 'exit' | 'staircase'
export type DoorType = 'no' | 'hinged' | 'sliding' | 'revolving' | 'yes'
export type Warning = 'revolving' | 'heavy' | 'steps' | 'level-mismatch'

export interface Entrance {
  id: string
  buildingId: string | null
  lat: number
  lon: number
  name: string | null
  kind: EntranceKind
  level: number | null
  stepFree: boolean | null // null = unknown. Never coerce to false.
  tier: Tier
  confidence: Confidence
  door: DoorType | null
  automatic: boolean
  approachBearing: number | null
  description: string | null
  warnings: Warning[] | string[]
  source: 'osm' | 'places' | 'survey'
}

export interface Building {
  id: string
  name: string | null
  placeId: string | null
  addr: string | null
  centroid: [number, number]
  accessSummary: { tier: Tier; stepFree: boolean | null; confidence: Confidence }
  entranceIds: string[]
  stats: { total: number; stepFree: number; notStepFree: number; unknown: number }
}

export interface Meta {
  version: number
  generated: string
  area: string
  bbox: [number, number, number, number]
  counts: { buildings: number; entrances: number; tier1: number }
}

export interface Dataset {
  meta: Meta
  buildings: Building[]
  entrances: Entrance[]
}

export interface LivedClaim {
  quote: string
  author: string
  topic: string
  coords: null
}
