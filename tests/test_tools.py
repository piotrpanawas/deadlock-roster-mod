"""Offline tests for the build helpers (no game files needed)."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import build  # noqa: E402
import bundle  # noqa: E402
from vpk import pack, read_index  # noqa: E402

STOCK = '<root>\n\t<styles>\n\t\t<include src="s2r://a.vcss" />\n\t</styles>\n\t<Panel />\n</root>'
PATCHED = STOCK.replace('\t</styles>\n', '\t</styles>\n\t<scripts>\n\t\t<include src="s2r://%s" />\n\t</scripts>\n' % build.SCRIPT)


class VpkTest(unittest.TestCase):
    def test_round_trip_index_and_determinism(self):
        files = {build.LAYOUT: b'layout', build.SCRIPT: b'script'}
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp, 'a.vpk'), Path(tmp, 'b.vpk')
            pack(files, a)
            pack(dict(reversed(list(files.items()))), b)
            self.assertEqual(sorted(read_index(a)), sorted(files))
            self.assertEqual(a.read_bytes(), b.read_bytes())

    def test_rejects_unsafe_paths(self):
        for name in ['../x.vjs_c', '/abs.vjs_c', 'noext', 'Upper/Case.vjs_c', 'a\\b.vjs_c']:
            with self.assertRaises(ValueError, msg=name), tempfile.TemporaryDirectory() as tmp:
                pack({name: b'x'}, Path(tmp, 'x.vpk'))


class LayoutDiffTest(unittest.TestCase):
    def test_accepts_exactly_one_include(self):
        build.check_layout_diff(STOCK, PATCHED)

    def test_rejects_other_changes(self):
        with self.assertRaises(SystemExit):
            build.check_layout_diff(STOCK, PATCHED.replace('<Panel />', '<Panel id="x" />'))
        with self.assertRaises(SystemExit):
            build.check_layout_diff(STOCK, STOCK)


class BundleTest(unittest.TestCase):
    def test_deterministic_build_id(self):
        first, second = bundle.bundle(), bundle.bundle()
        self.assertEqual(first, second)
        self.assertRegex(first, r'var BUILD_ID = "%s\+[0-9a-f]{8}";' % bundle.VERSION.replace('.', r'\.'))
        self.assertIn('var BRIDGE_URL = "https://', first)

    def test_build_id_follows_bridge_url(self):
        self.assertNotEqual(bundle.bundle(''), bundle.bundle())
        self.assertIn('var BRIDGE_URL = "";', bundle.bundle(''))

    def test_rejects_non_https_bridge(self):
        original = bundle.BRIDGE_CONFIG
        with tempfile.TemporaryDirectory() as tmp:
            bundle.BRIDGE_CONFIG = Path(tmp, 'b.json')
            bundle.BRIDGE_CONFIG.write_text('{"url": "http://example.com/b.html"}')
            try:
                with self.assertRaises(ValueError):
                    bundle.bundle()
            finally:
                bundle.BRIDGE_CONFIG = original


if __name__ == '__main__':
    unittest.main()
