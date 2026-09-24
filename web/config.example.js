// Copy to web/config.js (gitignored) and, on deploy, place it next to index.html.
// It is loaded at runtime and never bundled, so no key ends up in dist/.
//
// mapsKey: a Google Maps JavaScript API browser key. Restrict it in Google Cloud to
//          HTTP referrers (your demo domain) and to the Maps JavaScript API only.
//          Gemini / Places keys NEVER go here; they live in the server's environment.
// mapId:   optional vector Map ID (Google Cloud > Map Management, type JavaScript, Vector,
//          tilt + rotation on). Rotation needs a vector map; unset = Google's DEMO_MAP_ID.
// apiBase: where /api/* lives. Empty = same origin (the dev server proxies /api).
window.DOORWAY_CONFIG = {
  mapsKey: '',
  apiBase: '',
}
