// Pure geometry. No I/O. Unit-tested in test/geo.test.ts.

export interface LatLon {
  lat: number
  lon: number
}

const R = 6371008.8 // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

export function normalize360(d: number): number {
  const n = d % 360
  return n < 0 ? n + 360 : n === 0 ? 0 : n
}

export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial great-circle bearing, 0..360, true north. */
export function bearingDeg(from: LatLon, to: LatLon): number {
  const f1 = rad(from.lat)
  const f2 = rad(to.lat)
  const dl = rad(to.lon - from.lon)
  const y = Math.sin(dl) * Math.cos(f2)
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)
  return normalize360(deg(Math.atan2(y, x)))
}

/** Signed turn from heading to target: negative = turn left, positive = turn right. -180..180. */
export function relativeBearing(target: number, heading: number): number {
  const d = normalize360(target - heading)
  return d > 180 ? d - 360 : d
}

/** Point at distance/bearing from origin (used by the simulator and tests). */
export function destination(from: LatLon, bearing: number, distanceM: number): LatLon {
  const d = distanceM / R
  const b = rad(bearing)
  const f1 = rad(from.lat)
  const l1 = rad(from.lon)
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(b))
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2))
  return { lat: deg(f2), lon: deg(l2) }
}
