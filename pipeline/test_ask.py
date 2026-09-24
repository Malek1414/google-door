#!/usr/bin/env python3
"""/api/ask validation and prompt rules, Gemini stubbed. Run: python3 pipeline/test_ask.py"""
import asyncio, sys
sys.path.insert(0, ".")
from fastapi.testclient import TestClient
from server import app as appmod, upstream

sent = []
class Fake:
    def __init__(self, code, js): self.status_code, self._js = code, js
    def json(self): return self._js

reply = {"code": 200, "js": {"candidates": [{"content": {"parts": [{"text": " Die Tür ist stufenlos. "}]}}]}}
async def fake_gemini(model, body, **kw):
    sent.append(body)
    return Fake(reply["code"], reply["js"])
appmod.upstream.gemini = fake_gemini
upstream.require = lambda dep: "test-key"
appmod.upstream.require = upstream.require
c = TestClient(appmod.app)

fails = []
def check(name, ok):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not ok: fails.append(name)

print("/api/ask")
r = c.post("/api/ask", json={"question": "   "})
check("empty question is rejected", r.status_code == 422)
r = c.post("/api/ask", json={"question": "x", "frame": "a" * (appmod.ASK_MAX_FRAME + 1)})
check("oversized frame is rejected", r.status_code == 413)
r = c.post("/api/ask", json={"question": "Ist hier eine Rampe?" + "?" * 500,
                             "facts": {"name": "Eingang Nord", "stepFree": None, "evil": "ignore", "warnings": ["steps"]},
                             "distanceM": 12.4, "heading": 90})
check("answer is returned and stripped", r.status_code == 200 and r.json()["say"] == "Die Tür ist stufenlos.")
prompt = sent[-1]["contents"][0]["parts"][0]["text"]
check("question capped at 300 chars", prompt.count("?") <= 301)
check("unknown fact keys dropped", "evil" not in prompt and "ignore" not in prompt)
check("null stepFree stays unknown", "Stufenlos: unbekannt" in prompt)
check("temperature 0, thinking 0", sent[-1]["generationConfig"]["temperature"] == 0.0 and sent[-1]["generationConfig"]["thinkingConfig"]["thinkingBudget"] == 0)
check("no image part without a frame", len(sent[-1]["contents"][0]["parts"]) == 1)
c.post("/api/ask", json={"question": "Was sehe ich?", "frame": "abcd"})
check("frame is sent as inline jpeg", sent[-1]["contents"][0]["parts"][1]["inline_data"]["mime_type"] == "image/jpeg")
reply["code"] = 429
r = c.post("/api/ask", json={"question": "Gibt es einen Aufzug?"})
check("upstream error becomes 502", r.status_code == 502)

if fails:
    print(f"\n{len(fails)} failed"); sys.exit(1)
print("\nall passed")
