"""Registers the P4 marker for the Krita plugin tests (pytest.ini lists P0..P3)."""


def pytest_configure(config):
    config.addinivalue_line("markers", "P4: phase P4")
