"""GET /api/arcore-token: clean 503 without a service account, cached token with one."""
import datetime as dt
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server import arcore


@pytest.fixture()
def client(monkeypatch):
    arcore.reset()
    monkeypatch.delenv(arcore.ENV, raising=False)
    app = FastAPI()
    app.include_router(arcore.router)
    yield TestClient(app)
    arcore.reset()


def test_without_credentials_is_a_clean_503(client):
    r = client.get("/api/arcore-token")
    assert r.status_code == 503
    assert r.json() == {"detail": "ARCore nicht eingerichtet"}


def test_env_pointing_nowhere_is_the_same_503(client, monkeypatch, tmp_path):
    monkeypatch.setenv(arcore.ENV, str(tmp_path / "missing.json"))
    r = client.get("/api/arcore-token")
    assert r.status_code == 503
    assert r.json()["detail"] == "ARCore nicht eingerichtet"


class FakeCreds:
    refreshes = 0

    def __init__(self):
        self.token = None
        self.expiry = None

    def refresh(self, _request):
        FakeCreds.refreshes += 1
        self.token = f"fake-token-{FakeCreds.refreshes}"
        self.expiry = dt.datetime.utcnow() + dt.timedelta(hours=1)


def test_mocked_credential_mints_and_caches(client, monkeypatch, tmp_path, caplog):
    sa = tmp_path / "sa.json"
    sa.write_text(json.dumps({"type": "service_account"}))
    monkeypatch.setenv(arcore.ENV, str(sa))
    FakeCreds.refreshes = 0
    seen_scopes = []

    def fake_from_file(path, scopes):
        seen_scopes.extend(scopes)
        return FakeCreds()

    from google.oauth2 import service_account

    monkeypatch.setattr(service_account.Credentials, "from_service_account_file", staticmethod(fake_from_file))

    with caplog.at_level("DEBUG"):
        a = client.get("/api/arcore-token")
        b = client.get("/api/arcore-token")
    assert a.status_code == 200 and b.status_code == 200
    assert a.json()["token"] == "fake-token-1"
    assert b.json()["token"] == "fake-token-1", "second call must come from the cache"
    assert FakeCreds.refreshes == 1
    assert 3300 < a.json()["expiresIn"] <= 3600
    assert seen_scopes == ["https://www.googleapis.com/auth/arcore"]
    assert a.headers["cache-control"] == "no-store"
    assert "fake-token" not in caplog.text


def test_refresh_failure_is_502_and_logs_no_detail(client, monkeypatch, tmp_path, caplog):
    sa = tmp_path / "sa.json"
    sa.write_text("{}")
    monkeypatch.setenv(arcore.ENV, str(sa))

    class Boom:
        token = None
        expiry = None

        def refresh(self, _r):
            raise RuntimeError("secret-material-in-message")

    from google.oauth2 import service_account

    monkeypatch.setattr(service_account.Credentials, "from_service_account_file", staticmethod(lambda p, scopes: Boom()))
    r = client.get("/api/arcore-token")
    assert r.status_code == 502
    assert "secret-material" not in caplog.text


def test_rate_limit(client):
    codes = [client.get("/api/arcore-token").status_code for _ in range(arcore.RATE_LIMIT + 1)]
    assert codes[:-1] == [503] * arcore.RATE_LIMIT
    assert codes[-1] == 429
