#!/usr/bin/env python3
"""Tests for the domain-correctness gate (runtime/skills/core/domain-check).

Run: python scripts/dev/test_domain_check.py
Stdlib unittest only — no pytest dependency.
"""
import importlib.util
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True  # never leave __pycache__ in the shipped skill dir

_MOD = (
    Path(__file__).resolve().parents[2]
    / "runtime/skills/core/domain-check/domain_check.py"
)
_spec = importlib.util.spec_from_file_location("domain_check", _MOD)
assert _spec and _spec.loader
dc = importlib.util.module_from_spec(_spec)
sys.modules["domain_check"] = dc  # dataclass annotation resolution needs this
_spec.loader.exec_module(dc)


def findings(src: str, lang: str = "python"):
    return dc.analyze(dc._build_ctx("t." + ("py" if lang == "python" else "R"), src, lang))


def tags(src: str, lang: str = "python"):
    return {f.tag for f in findings(src, lang)}


class Physics(unittest.TestCase):
    def test_dimensional_mismatch_add(self):
        fs = findings("t_seconds = 3\nd_meters = 5\nx = t_seconds + d_meters\n")
        self.assertTrue(any(f.tag == "physics · units" and "mismatch" in f.title.lower() for f in fs))

    def test_dimensional_mismatch_compare(self):
        fs = findings("a_km = 1\nb_s = 2\nif a_km > b_s:\n    pass\n")
        self.assertIn("physics · units", {f.tag for f in fs})

    def test_trig_on_degrees(self):
        fs = findings("import numpy as np\nangle_deg = 90\ny = np.sin(angle_deg)\n")
        self.assertTrue(any("degree" in f.title.lower() for f in fs))

    def test_same_family_ok(self):
        # km + m are both length -> no dimensional finding.
        self.assertNotIn("physics · units", tags("a_km = 1\nb_m = 2\nx = a_km + b_m\n"))

    def test_unknown_units_ok(self):
        # No recognized unit suffix -> silent (precision over recall).
        self.assertNotIn("physics · units", tags("total = price + count\n"))


class Earth(unittest.TestCase):
    def test_euclidean_sqrt_latlon(self):
        src = (
            "import numpy as np\n"
            "d = np.sqrt((lat1 - lat2) + (lon1 - lon2))\n"
        )
        self.assertIn("earth · crs", tags(src))

    def test_classic_squared_diff(self):
        src = "dist = (lat1 - lat2)**2 + (lon1 - lon2)**2\n"
        self.assertIn("earth · crs", tags(src))

    def test_geopandas_no_crs(self):
        src = (
            "import geopandas as gpd\n"
            "gdf = gpd.read_file('x.shp')\n"
            "gdf['d'] = gdf.geometry.distance(other)\n"
        )
        self.assertIn("earth · crs", tags(src))

    def test_geopandas_with_crs_ok(self):
        src = (
            "import geopandas as gpd\n"
            "gdf = gpd.read_file('x.shp').to_crs(3857)\n"
            "gdf['d'] = gdf.geometry.distance(other)\n"
        )
        self.assertNotIn("earth · crs", tags(src))

    def test_planar_distance_ok(self):
        # x/y without lat/lon naming should not trip the euclidean rule.
        self.assertNotIn("earth · crs", tags("d = ((x1 - x2)**2 + (y1 - y2)**2)**0.5\n"))


class Driver(unittest.TestCase):
    def test_run_emits_contract(self):
        # end-to-end: temp file -> run() -> review contract shape.
        import tempfile, os
        d = tempfile.mkdtemp()
        p = os.path.join(d, "a.py")
        with open(p, "w") as fh:
            fh.write("t_seconds = 1\nd_meters = 2\nx = t_seconds + d_meters\n")
        res = dc.run([p])
        self.assertIn("findings", res)
        self.assertIn("note", res)
        self.assertTrue(res["findings"])
        f0 = res["findings"][0]
        self.assertEqual(f0["check"], "domain")
        self.assertIn("tag", f0)
        self.assertNotIn("no error", res["note"].lower())

    def test_syntax_error_no_crash(self):
        # Malformed python must not crash the gate.
        res = dc.analyze(dc._build_ctx("bad.py", "def (:\n", "python"))
        self.assertEqual(res, [])

    def test_r_trig_regex_fallback(self):
        fs = findings("y <- sin(angle_deg)\n", lang="r")
        self.assertTrue(any("degree" in f.title.lower() for f in fs))


if __name__ == "__main__":
    unittest.main(verbosity=2)
