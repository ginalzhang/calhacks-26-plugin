"""Steady Krita plugin: packaging + install script (run against a temp HOME, never the real one)."""
from __future__ import annotations

import configparser
import os
import py_compile
import subprocess

import pytest

from krita_fakes import PYKRITA, ROOT

pytestmark = pytest.mark.P2a

SCRIPT = ROOT / "scripts" / "krita-plugin-install.sh"


def test_desktop_file_fields():
    cp = configparser.ConfigParser(interpolation=None)
    cp.optionxform = str
    cp.read(PYKRITA / "steady.desktop")
    e = cp["Desktop Entry"]
    assert e["Type"] == "Service"
    assert e["ServiceTypes"] == "Krita/PythonPlugin"
    assert e["X-KDE-Library"] == "steady"
    assert e["X-Python-2-Compatible"] == "false"
    assert e["Name"] == "Steady"
    assert e["Comment"]


def test_plugin_files_compile():
    for f in ("__init__.py", "bridge.py", "dispatch.py", "adapter.py"):
        py_compile.compile(str(PYKRITA / "steady" / f), doraise=True)


def test_package_import_outside_krita_registers_nothing():
    import steady

    assert steady.Krita is None
    assert not hasattr(steady, "SteadyExtension")


def test_adapter_has_pyqt6_fallback_and_tested_note():
    src = (PYKRITA / "steady" / "adapter.py").read_text()
    assert "from PyQt5" in src and "from PyQt6" in src and "except ImportError" in src
    init = (PYKRITA / "steady" / "__init__.py").read_text()
    assert "5.3" in init and "addExtension" in init and "setInterval(20)" in init


def test_install_script_into_temp_home(tmp_path):
    env = dict(os.environ, HOME=str(tmp_path))
    env.pop("KRITA_PYKRITA_DIR", None)
    out = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    dest = tmp_path / "Library" / "Application Support" / "krita" / "pykrita"
    assert (dest / "steady.desktop").read_text() == (PYKRITA / "steady.desktop").read_text()
    installed = sorted(p.name for p in (dest / "steady").iterdir())
    assert installed == ["__init__.py", "adapter.py", "bridge.py", "dispatch.py"]
    assert "Python Plugin Manager" in out.stdout
    # idempotent, and leaves other plugins alone
    (dest / "other_plugin.desktop").write_text("x")
    (dest / "steady" / "stale.py").write_text("x")
    out = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=30)
    assert out.returncode == 0
    assert (dest / "other_plugin.desktop").exists()
    assert not (dest / "steady" / "stale.py").exists()


def test_install_script_honours_override_dir(tmp_path):
    env = dict(os.environ, HOME=str(tmp_path / "home"), KRITA_PYKRITA_DIR=str(tmp_path / "pk"))
    out = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    assert (tmp_path / "pk" / "steady" / "dispatch.py").exists()
    assert not (tmp_path / "home").exists()
