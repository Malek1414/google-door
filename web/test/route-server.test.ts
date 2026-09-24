// Regression cover for Malek's e21a687, server side, driven from vitest so `npm test`
// catches it. Each case runs a short Python script against the real server modules.
//
//   decode_polyline   Google's reference string decodes to Google's reference points
//   /api/route        without a key answers 503 not_configured, never a 200 "found:false"
//                     (which the client used to draw as a crow-flight line)
//   /api/door-fix     rides out Gemini 429/503 and gives up after a bounded number of
//                     tries, so it no longer fails on the first busy minute
//
// Needs python3 with fastapi, httpx and pydantic (the server's own deps). Set
// DOORWAY_PYTHON to point at a venv; without the deps the suite is skipped, not failed.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const PY = [process.env.DOORWAY_PYTHON, resolve(ROOT, '.venv/bin/python'), 'python3'].find((p) => p && (p === 'python3' || existsSync(p)))!
const hasDeps = spawnSync(PY, ['-c', 'import fastapi, httpx, pydantic'], { cwd: ROOT }).status === 0

// Every script starts here: no network (httpx.AsyncClient answers from `codes`, in
// order, repeating the last), no backoff sleeps, and keys set per case. Patched before
// the server modules import, so it holds however they reach httpx and asyncio.
const PRELUDE = (codes: number[], gemini: unknown = {}) => `
import json, asyncio, httpx
CODES = ${JSON.stringify(codes)}
CALLS = []
class FakeClient:
    def __init__(self, *a, **k): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False
    async def request(self, method, url, **k): return self._next(url)
    async def post(self, url, **k): return self._next(url)
    async def get(self, url, **k): return self._next(url)
    def _next(self, url):
        CALLS.append(url)
        code = CODES[min(len(CALLS) - 1, len(CODES) - 1)]
        body = ${JSON.stringify(JSON.stringify(gemini))} if code == 200 else json.dumps({"error": {"message": "API keys are not supported by this API."}})
        return httpx.Response(code, content=body.encode(), headers={"content-type": "application/json"}, request=httpx.Request("POST", url))
httpx.AsyncClient = FakeClient
async def _no_sleep(*a, **k): pass
asyncio.sleep = _no_sleep
`

function py(script: string, env: Record<string, string> = {}): unknown {
  const out = execFileSync(PY, ['-c', script], {
    cwd: ROOT,
    // No keys from the developer's shell. Empty (not absent) so a .env loader using
    // setdefault cannot fill them in either.
    env: { PATH: process.env.PATH ?? '', PYTHONPATH: ROOT, HOME: process.env.HOME ?? '', MAPS_API_KEY: '', ROUTES_API_KEY: '', GEMINI_API_KEY: '', ...env },
    encoding: 'utf8',
    timeout: 30000,
  })
  return JSON.parse(out.trim().split('\n').pop()!)
}

const ROUTE_REQ = '{"fromLat": 52.5249, "fromLon": 13.3688, "toLat": 52.5254, "toLon": 13.3704}'
const client = (module: string) => `
from fastapi import FastAPI
from fastapi.testclient import TestClient
import ${module} as mod
_app = FastAPI(); _app.include_router(mod.router)
client = TestClient(_app)
`

describe.skipIf(!hasDeps)('server/route.py and server/approach.py (python)', () => {
  it('decode_polyline: Google\'s reference example', () => {
    const pts = py(`
import json
from server.route import decode_polyline
print(json.dumps(decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq\`@")))
`) as number[][]
    expect(pts).toEqual([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]])
  })

  it('decode_polyline: a truncated string stops cleanly instead of inventing a point', () => {
    const pts = py(`
import json
from server.route import decode_polyline
print(json.dumps(decode_polyline("_p~iF~ps|U_ulL")))
`) as number[][]
    expect(pts).toEqual([[38.5, -120.2]])
  })

  it('/api/route without a key is a 503 that names the problem, not a silent found:false', () => {
    const r = py(`${PRELUDE([200])}${client('server.route')}
res = client.post("/api/route", json=json.loads('${ROUTE_REQ}'))
print(json.dumps({"status": res.status_code, "body": res.json(), "calls": len(CALLS)}))
`) as { status: number; body: unknown; calls: number }
    expect(r.status).toBe(503)
    expect(JSON.stringify(r.body)).toMatch(/not_configured|API_KEY/)
    expect(r.calls).toBe(0)
  })

  it('/api/route passes a Routes 401 on as code "auth" (the AQ. key case)', () => {
    const r = py(`${PRELUDE([401])}${client('server.route')}
res = client.post("/api/route", json=json.loads('${ROUTE_REQ}'))
print(json.dumps({"status": res.status_code, "body": res.json()}))
`, { ROUTES_API_KEY: 'AQ.test', MAPS_API_KEY: 'AQ.test' }) as { status: number; body: { detail: { code: string } } }
    expect(r.status).toBe(502)
    expect(r.body.detail.code).toBe('auth')
  })

  // A Gemini reply in the shape _ask parses: the model's JSON inside candidates[0].
  const FIX = { found: true, bearingDeg: -12, distanceM: 6, confidence: 0.9, kind: 'sliding', note: 'Glastür', inside: false }
  const GEMINI = { candidates: [{ content: { parts: [{ text: JSON.stringify(FIX) }] } }] }
  const doorFix = (codes: number[]) => py(`${PRELUDE(codes, GEMINI)}${client('server.approach')}
res = client.post("/api/door-fix", json={"frame": "AAAA", "headingDeg": 90})
print(json.dumps({"status": res.status_code, "body": res.json(), "calls": len(CALLS)}))
`, { GEMINI_API_KEY: 'test' }) as { status: number; body: { found: boolean; bearingDeg: number }; calls: number }

  it('/api/door-fix: one 429 from Gemini, then 200, is still a fix (bug 5)', () => {
    const r = doorFix([429, 200])
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ found: true, bearingDeg: -12 })
    expect(r.calls).toBe(2)
  })

  it('/api/door-fix: 429, 503, then 200 is still a fix', () => {
    const r = doorFix([429, 503, 200])
    expect(r.status).toBe(200)
    expect(r.calls).toBe(3)
  })

  it('/api/door-fix: gives up after a bounded number of tries with a 5xx, not a hang', () => {
    const r = doorFix([429])
    expect(r.status).toBeGreaterThanOrEqual(500)
    expect(r.calls).toBeGreaterThanOrEqual(2)
    expect(r.calls).toBeLessThanOrEqual(5)
  })

  it('/api/door-fix: each upstream try fits inside the client\'s 5 s door-fix budget', () => {
    const r = py(`${PRELUDE([200], GEMINI)}${client('server.approach')}
import server.upstream as up
KW = []
_real = up.request
async def _spy(*a, **k):
    KW.append(k.get("timeout"))
    return await _real(*a, **k)
up.request = _spy
res = client.post("/api/door-fix", json={"frame": "AAAA", "headingDeg": 90})
print(json.dumps({"status": res.status_code, "timeout": KW[0]}))
`, { GEMINI_API_KEY: 'test' }) as { status: number; timeout: number }
    expect(r.status).toBe(200)
    expect(r.timeout).toBeLessThan(5)
  })

  it('/api/door-fix: a 400 is not retried', () => {
    expect(doorFix([400, 200]).calls).toBe(1)
  })
})
