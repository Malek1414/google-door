"""Surveyed door descriptions reach the vision prompts (server/approach.py)."""
import json

from server import approach

ID = "demo/google-accessible"


def test_google_accessible_door_has_a_target_and_a_small_reference():
    approach._targets = None
    t = approach.target_for(ID)
    assert t is not None
    assert "Barrierefreier Zugang" in t["en"]
    assert t["ref"] and len(t["ref"]) * 3 / 4 <= approach.REF_MAX_BYTES


def test_unknown_door_leaves_look_text_unchanged():
    assert approach.target_for("node/1") is None
    assert approach.look_target_text("node/1", "entrance, hinged door") == "entrance, hinged door"


def test_look_matches_by_name_when_no_id_is_sent():
    text = "step-free entrance, hinged door, named Google Berlin, barrierefreier Zugang Tucholskystraße 2"
    out = approach.look_target_text(None, text)
    assert out.startswith(text) and "Barrierefreier Zugang" in out[len(text):]


def test_route_file_agrees_with_the_dataset():
    r = json.load(open("data/demo/google/route.json", encoding="utf-8"))
    d = json.load(open("data/berlin-mitte.json", encoding="utf-8"))
    e = next(x for x in d["entrances"] if x["id"] == r["entranceId"])
    assert e["name"] == r["entranceName"]
    assert e["tier"] == 1 and e["stepFree"] is True
    assert (e["lat"], e["lon"], e["approachBearing"]) == (r["door"]["lat"], r["door"]["lon"], r["door"]["approachBearing"])
    main = next(x for x in d["entrances"] if x["id"] == r["mainEntranceId"])
    assert main["stepFree"] is False and "steps" in main["warnings"]


def _client(monkeypatch, seen):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    class R:
        status_code = 200

        def json(self):
            txt = json.dumps({"found": False, "confidence": 0.9})
            return {"candidates": [{"content": {"parts": [{"text": txt}]}}]}

    async def fake(model, body, **kw):
        seen.append(body)
        return R()

    monkeypatch.setattr(approach.upstream, "gemini", fake)
    app = FastAPI()
    app.include_router(approach.router)
    return TestClient(app)


def test_door_fix_sends_target_text_and_reference_for_a_surveyed_door(monkeypatch):
    approach._targets = None
    seen = []
    c = _client(monkeypatch, seen)
    assert c.post("/api/door-fix", json={"frame": "AAAA", "headingDeg": 1, "doorId": ID}).status_code == 200
    parts = seen[0]["contents"][0]["parts"]
    assert "THE ENTRANCE TO FIND" in parts[0]["text"] and "IMAGE 2" in parts[0]["text"]
    images = [p["inline_data"]["data"] for p in parts if "inline_data" in p]
    assert len(images) == 2 and images[-1] == "AAAA"  # live frame last


def test_door_fix_without_door_id_is_unchanged(monkeypatch):
    seen = []
    c = _client(monkeypatch, seen)
    assert c.post("/api/door-fix", json={"frame": "AAAA", "headingDeg": 1}).status_code == 200
    parts = seen[0]["contents"][0]["parts"]
    assert parts[0]["text"] == approach.FIX_PROMPT and len(parts) == 2
