"""Tests for CDN invalidation simulation, surrogate-key dispatch, and listeners."""
import pytest
from backend.app.cdn import CDNManager


def test_cdn_purge_key_recording():
    cdn = CDNManager()
    res = cdn.purge_key("video-abc12345")
    assert res["status"] == "purged"
    assert res["key"] == "video-abc12345"
    assert cdn.get_purged_keys() == ["video-abc12345"]


def test_cdn_listener_notification():
    cdn = CDNManager()
    dispatched = []

    def hook(key: str):
        dispatched.append(key)

    cdn.register_listener(hook)
    cdn.purge_key("video-999")
    cdn.purge_key("taxonomy")

    assert dispatched == ["video-999", "taxonomy"]
    assert cdn.get_purged_keys() == ["video-999", "taxonomy"]


def test_cdn_listener_error_resilience():
    cdn = CDNManager()

    def buggy_hook(key: str):
        raise RuntimeError("Network timeout to Fastly/Cloudflare")

    cdn.register_listener(buggy_hook)
    # Should not raise exception
    res = cdn.purge_key("video-error-test")
    assert res["status"] == "purged"
    assert "video-error-test" in cdn.get_purged_keys()


def test_cdn_clear_purge_history():
    cdn = CDNManager()
    cdn.purge_key("video-1")
    cdn.purge_key("video-2")
    assert len(cdn.get_purged_keys()) == 2
    cdn.clear_purge_history()
    assert len(cdn.get_purged_keys()) == 0
