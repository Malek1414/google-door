// The rear camera, shared by Start, Live View and the approach screen.
//
// Rules learned the hard way on iOS WKWebView:
//  - the <video> needs playsinline + muted + autoplay, set as attributes AND properties,
//    or iOS goes fullscreen / refuses to play;
//  - one stream for the whole session: a second getUserMedia while one is live can kill
//    the first on iOS, and every re-acquire shows a black gap;
//  - after the app comes back from the background the track may have ended (or the video
//    just paused): re-acquire if ended, play() again either way;
//  - the video stays invisible until it has a frame (loadeddata), so the user never sees
//    a black rectangle flash;
//  - tracks are stopped shortly after the last camera screen closes (the camera light goes
//    off), but not in between Live View and the approach screen, which hand over directly.

import { session } from '../session'

export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  audio: false,
}

/** Grace period between one camera screen closing and the next claiming the stream. */
export const RELEASE_AFTER_MS = 1500

export type CameraError = 'denied' | 'unavailable'

/** Pure. A stream is reusable while it has at least one live video track. */
export function streamLive(st: MediaStream | null | undefined): boolean {
  if (!st) return false
  try {
    return st.getVideoTracks().some((tr) => tr.readyState === 'live')
  } catch {
    return false
  }
}

/** Pure. Maps a getUserMedia rejection onto what the user can do about it. */
export function cameraErrorKind(err: unknown): CameraError {
  const name = (err as { name?: string } | null)?.name ?? ''
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError' ? 'denied' : 'unavailable'
}

let pending: Promise<MediaStream> | null = null

/** The session stream if still live, else a fresh one (stored in session.stream). */
export async function acquireCamera(): Promise<MediaStream> {
  if (streamLive(session.stream)) return session.stream!
  if (pending) return pending
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no camera'), { name: 'NotFoundError' })
  session.stream?.getTracks().forEach((tr) => tr.stop())
  session.stream = null
  pending = navigator.mediaDevices
    .getUserMedia(CAMERA_CONSTRAINTS)
    .catch((err: unknown) => {
      // A refusal stays a refusal (no second prompt). Anything else may be a WebView
      // rejecting the size hints outright: retry with the bare minimum.
      if (cameraErrorKind(err) === 'denied') throw err
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
    })
    .then((st) => {
      session.stream = st
      return st
    })
    .finally(() => {
      pending = null
    })
  return pending
}

let users = 0
let releaseTimer = 0

function claim(): void {
  users++
  clearTimeout(releaseTimer)
}

function release(): void {
  users = Math.max(0, users - 1)
  clearTimeout(releaseTimer)
  if (users > 0) return
  releaseTimer = window.setTimeout(() => {
    if (users > 0) return
    session.stream?.getTracks().forEach((tr) => tr.stop())
    session.stream = null
  }, RELEASE_AFTER_MS)
}

/** Create a camera <video> with every attribute iOS needs. Hidden until it has a frame. */
export function cameraVideo(className: string): HTMLVideoElement {
  const v = document.createElement('video')
  v.className = className
  for (const a of ['playsinline', 'webkit-playsinline', 'muted', 'autoplay']) v.setAttribute(a, '')
  v.setAttribute('aria-hidden', 'true')
  v.muted = true
  v.autoplay = true
  v.playsInline = true
  v.disablePictureInPicture = true
  return v
}

const COPY = {
  de: {
    denied: 'Kein Kamerazugriff. Erlaube die Kamera in den Einstellungen, dann tippe auf „Erneut versuchen“.',
    unavailable: 'Die Kamera startet gerade nicht.',
    retry: 'Erneut versuchen',
  },
  en: {
    denied: 'No camera access. Allow the camera in Settings, then tap “Try again”.',
    unavailable: 'The camera is not starting.',
    retry: 'Try again',
  },
}

/**
 * Wires `v` to the session camera: attach, reveal on first frame, recover after the
 * background, show a retry notice when refused. Returns the teardown (detaches, and
 * releases the stream once no camera screen is left).
 */
export function mountCamera(v: HTMLVideoElement, opts: { lang?: string; onError?: (e: CameraError) => void } = {}): () => void {
  claim()
  let closed = false
  let notice: HTMLElement | null = null
  const copy = (opts.lang ?? document.documentElement.lang ?? 'de').startsWith('en') ? COPY.en : COPY.de

  v.dataset.cam = 'wait'
  const reveal = () => {
    if (v.videoWidth || v.readyState >= 2) v.dataset.cam = 'on'
  }
  v.addEventListener('loadeddata', reveal)
  v.addEventListener('playing', reveal)
  v.addEventListener('resize', reveal)

  const play = () => {
    const p = v.play()
    if (p && typeof p.catch === 'function') p.catch(() => {})
  }

  const clearNotice = () => {
    notice?.remove()
    notice = null
  }

  const showNotice = (kind: CameraError) => {
    opts.onError?.(kind)
    const host = v.parentElement
    if (!host || closed) return
    clearNotice()
    notice = document.createElement('div')
    notice.className = 'cam-notice'
    notice.setAttribute('role', 'alert')
    const p = document.createElement('p')
    p.textContent = kind === 'denied' ? copy.denied : copy.unavailable
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'cam-retry'
    b.textContent = copy.retry
    b.addEventListener('click', () => void start())
    notice.append(p, b)
    host.append(notice)
  }

  const start = async () => {
    if (closed) return
    try {
      const st = await acquireCamera()
      if (closed) return
      clearNotice()
      if (v.srcObject !== st) {
        v.dataset.cam = 'wait'
        v.srcObject = st
      }
      // A track that ends under us (another app took the camera, iOS interruption).
      for (const tr of st.getVideoTracks()) tr.onended = () => !closed && document.visibilityState === 'visible' && void start()
      play()
      reveal()
    } catch (err) {
      if (!closed) showNotice(cameraErrorKind(err))
    }
  }

  const onVisible = () => {
    if (closed || document.visibilityState !== 'visible') return
    if (streamLive(v.srcObject as MediaStream | null)) play()
    else void start()
  }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('pageshow', onVisible)
  // Mounted before it is in the DOM: the notice needs a parent, so defer the first try.
  queueMicrotask(() => void start())

  return () => {
    if (closed) return
    closed = true
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('pageshow', onVisible)
    v.removeEventListener('loadeddata', reveal)
    v.removeEventListener('playing', reveal)
    v.removeEventListener('resize', reveal)
    clearNotice()
    try {
      v.pause()
    } catch {
      /* ignored */
    }
    v.srcObject = null
    release()
  }
}
