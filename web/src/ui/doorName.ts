// A readable, distinguishable name for an entrance. Most OSM doors have no name, and a list of
// eight "Eingang ohne Namen" rows cannot be told apart with VoiceOver. Unnamed doors get their
// kind plus where they are: the side of their building, or the direction from the user.

import { bearingDeg, type LatLon } from '../core/geo'
import type { Building, Entrance } from '../core/types'
import { t } from '../strings'

const sector = (deg: number) => Math.round(deg / 45) % 8

export function doorKindName(e: Pick<Entrance, 'kind'>): string {
  const k = t.doorKind
  return e.kind === 'main' ? k.main : e.kind === 'secondary' ? k.secondary : e.kind === 'emergency' ? k.emergency : e.kind === 'exit' ? k.exit : k.any
}

/** e.name when it has one, else e.g. "Haupteingang Hauptbahnhof, Nordseite" or "Eingang Richtung Nordosten". */
export function doorName(e: Entrance, origin: LatLon, buildings: Building[] = []): string {
  if (e.name?.trim()) return e.name.trim()
  const kind = doorKindName(e)
  const b = e.buildingId ? buildings.find((x) => x.id === e.buildingId) : undefined
  const where = b?.name || b?.addr
  if (b && where) {
    const [lat, lon] = b.centroid
    return t.doorAtBuilding(kind, t.doorSide[sector(bearingDeg({ lat, lon }, e))], where)
  }
  return t.doorToward(kind, t.compass[sector(bearingDeg(origin, e))])
}
