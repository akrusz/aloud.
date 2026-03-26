"""Tests for the update checker version utilities."""

import sys

from src.updater import _parse_version, _version_newer, _get_platform_asset_ext


class TestParseVersion:
    def test_with_v_prefix(self):
        assert _parse_version("v1.2.3") == (1, 2, 3)

    def test_without_v_prefix(self):
        assert _parse_version("1.2.3") == (1, 2, 3)

    def test_large_numbers(self):
        assert _parse_version("v0.99.99") == (0, 99, 99)

    def test_zero_version(self):
        assert _parse_version("v0.0.0") == (0, 0, 0)


class TestVersionNewer:
    def test_newer_major(self):
        assert _version_newer("v1.0.0", "v0.9.17") is True

    def test_equal_versions(self):
        assert _version_newer("v0.9.17", "v0.9.17") is False

    def test_older_patch(self):
        assert _version_newer("v0.9.16", "v0.9.17") is False

    def test_newer_major_vs_large_minor(self):
        assert _version_newer("v1.0.0", "v0.99.99") is True

    def test_invalid_remote(self):
        assert _version_newer("invalid", "v1.0.0") is False

    def test_invalid_local(self):
        assert _version_newer("v1.0.0", "invalid") is False

    def test_both_invalid(self):
        assert _version_newer("invalid", "also-invalid") is False

    def test_newer_minor(self):
        assert _version_newer("v0.10.0", "v0.9.17") is True

    def test_older_major(self):
        assert _version_newer("v0.9.17", "v1.0.0") is False


class TestGetPlatformAssetExt:
    def test_darwin(self, monkeypatch):
        monkeypatch.setattr(sys, "platform", "darwin")
        assert _get_platform_asset_ext() == ".dmg"

    def test_win32(self, monkeypatch):
        monkeypatch.setattr(sys, "platform", "win32")
        assert _get_platform_asset_ext() == ".exe"

    def test_linux(self, monkeypatch):
        monkeypatch.setattr(sys, "platform", "linux")
        assert _get_platform_asset_ext() == ".AppImage"
