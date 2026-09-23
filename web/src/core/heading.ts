// THE iOS / Android compass shim. The only platform-specific file in core/.
//
// iOS Safari:     DeviceOrientationEvent.requestPermission() in a tap, then
//                 event.webkitCompassHeading (true north, 0..360, use directly).
// Android Chrome: 'deviceorientationabsolute', heading = 360 - alpha. No permission call.
// Fallback:       GPS course over ground. Only valid while walking. source 'gps-course'
//                 tells the UI to soften the arrow into a cone.

import { normalize360 } from './geo'

export type HeadingSource = 'ios-webkit' | 'android-absolute' | 'gps-course' | 'none'
export interface Heading {
  deg: number
  accuracy: number | null
  source: HeadingSource
}

interface IOSOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number
  webkitCompassAccuracy?: number
}
type PermissionFn = () => Promise<'granted' | 'denied' | 'default'>

/** Wait this long for a compass event before falling back to GPS course. */
const COMPASS_TIMEOUT_MS = 2000
/** Below this speed GPS course is noise. */
const MIN_COURSE_SPEED_MS = 0.6

/** MUST be called synchronously from a tap handler (first await in the handler). */
export async function requestHeadingPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return false
  const req = (DeviceOrientationEvent as unknown as { requestPermission?: PermissionFn }).requestPermission
  if (typeof req === 'function') {
    try {
      return (await req.call(DeviceOrientationEvent)) === 'granted'
    } catch {
      return false // thrown when not in a user gesture, or in a WKWebView that blocks it
    }
  }
  return true // Android / desktop: no permission gate
}

export function startHeading(cb: (h: Heading) => void): () => void {
  let gotCompass = false
  let geoWatch: number | null = null

  const onIOS = (ev: Event) => {
    const e = ev as IOSOrientationEvent
    if (typeof e.webkitCompassHeading !== 'number' || Number.isNaN(e.webkitCompassHeading)) return
    gotCompass = true
    const acc = typeof e.webkitCompassAccuracy === 'number' && e.webkitCompassAccuracy >= 0 ? e.webkitCompassAccuracy : null
    cb({ deg: normalize360(e.webkitCompassHeading), accuracy: acc, source: 'ios-webkit' })
  }
  const onAbsolute = (ev: Event) => {
    const e = ev as DeviceOrientationEvent
    if (e.alpha === null) return
    gotCompass = true
    cb({ deg: normalize360(360 - e.alpha), accuracy: null, source: 'android-absolute' })
  }

  const hasAbsolute = 'ondeviceorientationabsolute' in window
  if (hasAbsolute) window.addEventListener('deviceorientationabsolute', onAbsolute)
  else window.addEventListener('deviceorientation', onIOS)

  const fallbackTimer = window.setTimeout(() => {
    if (gotCompass) return
    cb({ deg: 0, accuracy: null, source: 'none' }) // until the user starts walking
    if (!('geolocation' in navigator)) return
    geoWatch = navigator.geolocation.watchPosition(
      (pos) => {
        if (gotCompass) return
        const { heading, speed } = pos.coords
        if (heading === null || Number.isNaN(heading) || speed === null || speed < MIN_COURSE_SPEED_MS) return
        cb({ deg: normalize360(heading), accuracy: null, source: 'gps-course' })
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 1000 },
    )
  }, COMPASS_TIMEOUT_MS)

  return () => {
    window.clearTimeout(fallbackTimer)
    window.removeEventListener('deviceorientationabsolute', onAbsolute)
    window.removeEventListener('deviceorientation', onIOS)
    if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch)
  }
}
