#!/usr/bin/env python3
"""Open Science — domain-correctness gates (P0-5).

A deterministic, pluggable validator layer: one rule set per scientific field
that intercepts that field's classic error classes — code that *runs* but is
scientifically *wrong*. Findings are structured and dismissible; this NEVER
promises correctness, only flags known-dangerous patterns for a human.

Stdlib only (ast, re, json). It analyses the code the agent generated — it does
not trust model recall. Add a discipline by writing a `check_<field>(ctx)`
function and appending it to VALIDATORS; no other change is needed.

Usage:
    python domain_check.py file1.py notebook.ipynb analysis.R ...
    python domain_check.py            # scan code files under the cwd

Output: one ```review fenced JSON block on stdout (the app's reviewer contract).
"""
from __future__ import annotations

import ast
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# --------------------------------------------------------------------------- #
# Findings + file context
# --------------------------------------------------------------------------- #


@dataclass
class Finding:
    level: str  # "warn" | "error" | "ok"
    tag: str  # discipline · rule, e.g. "physics · units"
    title: str
    evidence: str


@dataclass
class Ctx:
    """One code file, parsed once and shared across every validator."""

    path: str
    src: str
    lang: str  # "python" | "r"
    tree: ast.AST | None = None  # populated for python
    lines: list[str] = field(default_factory=list)

    def line_of(self, node: ast.AST) -> int:
        return getattr(node, "lineno", 0)

    def snippet(self, lineno: int) -> str:
        if 1 <= lineno <= len(self.lines):
            return f"{self.path}:{lineno}  {self.lines[lineno - 1].strip()}"
        return f"{self.path}:{lineno}"


# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #


def _suffix(name: str) -> str:
    """Last underscore-delimited token, lowercased: `t_secs` -> `secs`."""
    return name.rsplit("_", 1)[-1].lower() if name else ""


def _names_in(node: ast.AST) -> list[str]:
    """Every identifier referenced under `node` (Name ids + attribute tails)."""
    out: list[str] = []
    for n in ast.walk(node):
        if isinstance(n, ast.Name):
            out.append(n.id)
        elif isinstance(n, ast.Attribute):
            out.append(n.attr)
    return out


def _call_name(node: ast.Call) -> str:
    """`np.hypot(...)` -> `hypot`; `sqrt(...)` -> `sqrt`."""
    f = node.func
    if isinstance(f, ast.Attribute):
        return f.attr
    if isinstance(f, ast.Name):
        return f.id
    return ""


# --------------------------------------------------------------------------- #
# Physics — units & dimensional consistency
# --------------------------------------------------------------------------- #

# A curated unit taxonomy. Suffix token -> dimension family. Kept to units that
# are unambiguous as a *trailing* name token in scientific code.
_UNIT_FAMILY: dict[str, str] = {}


def _reg(family: str, *units: str) -> None:
    for u in units:
        _UNIT_FAMILY[u] = family


_reg("length", "m", "meter", "meters", "metre", "metres", "km", "cm", "mm",
     "um", "nm", "mi", "mile", "miles", "ft", "feet", "yd", "au", "pc",
     "kpc", "mpc", "ly", "angstrom", "angstroms")
_reg("time", "s", "sec", "secs", "second", "seconds", "ms", "msec", "us",
     "ns", "min", "mins", "minute", "minutes", "hr", "hrs", "hour", "hours",
     "day", "days", "yr", "yrs", "year", "years", "gyr", "myr")
_reg("mass", "kg", "kgs", "gram", "grams", "mg", "ug", "lb", "lbs", "tonne",
     "tonnes", "amu", "msun", "solarmass")
_reg("angle", "deg", "degree", "degrees", "rad", "radian", "radians",
     "arcsec", "arcmin", "mas")
_reg("temperature", "kelvin", "celsius", "fahrenheit", "degc", "degk")

_TRIG = {"sin", "cos", "tan", "sec", "csc", "cot", "asin", "acos", "atan",
         "sinh", "cosh", "tanh"}


def _unit_family(name: str) -> str | None:
    return _UNIT_FAMILY.get(_suffix(name))


def check_physics(ctx: Ctx) -> list[Finding]:
    out: list[Finding] = []
    if ctx.tree is None:
        return _physics_regex(ctx)

    for node in ast.walk(ctx.tree):
        # (1) Add / subtract / compare across dimension families.
        pairs: list[tuple[ast.AST, ast.AST]] = []
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub)):
            pairs.append((node.left, node.right))
        elif isinstance(node, ast.Compare) and len(node.comparators) == 1:
            pairs.append((node.left, node.comparators[0]))
        for left, right in pairs:
            lf = _operand_family(left)
            rf = _operand_family(right)
            if lf and rf and lf != rf:
                op = "compare" if isinstance(node, ast.Compare) else "add/subtract"
                out.append(Finding(
                    "error", "physics · units",
                    f"Dimensional mismatch: {op} of {lf} and {rf}",
                    ctx.snippet(ctx.line_of(node))
                    + f"\n  left is a {lf} quantity, right is a {rf} quantity — "
                    "the result has no consistent unit.",
                ))

        # (2) Trig on a degree-named quantity (trig expects radians).
        if isinstance(node, ast.Call) and _call_name(node) in _TRIG:
            for arg in node.args:
                fam = _operand_family(arg)
                if fam == "angle" and _degree_named(arg):
                    out.append(Finding(
                        "error", "physics · units",
                        f"{_call_name(node)}() called on a degree-valued angle",
                        ctx.snippet(ctx.line_of(node))
                        + "\n  trig functions expect radians — convert with "
                        "np.radians()/math.radians() first.",
                    ))
    return out


def _operand_family(node: ast.AST) -> str | None:
    """The dimension family of a leaf operand (a bare Name/Attribute)."""
    if isinstance(node, ast.Name):
        return _unit_family(node.id)
    if isinstance(node, ast.Attribute):
        return _unit_family(node.attr)
    return None


def _degree_named(node: ast.AST) -> bool:
    if isinstance(node, ast.Name):
        return _suffix(node.id) in {"deg", "degree", "degrees"}
    if isinstance(node, ast.Attribute):
        return _suffix(node.attr) in {"deg", "degree", "degrees"}
    return False


def _physics_regex(ctx: Ctx) -> list[Finding]:
    """R fallback: catch trig on degree-named angles by pattern."""
    out: list[Finding] = []
    for m in re.finditer(r"\b(sin|cos|tan)\s*\(\s*([A-Za-z_.][\w.]*)\s*\)", ctx.src):
        if _suffix(m.group(2)) in {"deg", "degree", "degrees"}:
            ln = ctx.src[: m.start()].count("\n") + 1
            out.append(Finding(
                "error", "physics · units",
                f"{m.group(1)}() called on a degree-valued angle",
                ctx.snippet(ln) + "\n  trig expects radians.",
            ))
    return out


# --------------------------------------------------------------------------- #
# Earth / geo — CRS & coordinate awareness
# --------------------------------------------------------------------------- #

_DIST_FUNCS = {"sqrt", "hypot", "dist", "euclidean", "norm", "pdist", "cdist"}


def _is_lat(name: str) -> bool:
    return name.lower().startswith("lat")


def _is_lon(name: str) -> bool:
    n = name.lower()
    return n.startswith("lon") or n.startswith("lng")


def _refs_latlon(node: ast.AST) -> bool:
    names = _names_in(node)
    return any(_is_lat(n) for n in names) and any(_is_lon(n) for n in names)


def check_earth(ctx: Ctx) -> list[Finding]:
    out: list[Finding] = []
    if ctx.tree is None:
        return out

    for node in ast.walk(ctx.tree):
        # (1) Euclidean distance on geographic coordinates.
        if isinstance(node, ast.Call) and _call_name(node) in _DIST_FUNCS:
            if any(_refs_latlon(a) for a in node.args) or _refs_latlon(node):
                out.append(_crs_finding(ctx, node))
        # (1b) The classic (lat1-lat2)**2 + (lon1-lon2)**2 form.
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            if _is_sq_diff(node.left) and _is_sq_diff(node.right):
                if _refs_latlon(node):
                    out.append(_crs_finding(ctx, node))

    # (2) A geopandas geometric op with no CRS ever set in the file.
    src = ctx.src
    if re.search(r"\b(geopandas|gpd|GeoDataFrame|GeoSeries)\b", src):
        geo_op = re.search(r"\.(distance|area|buffer|length|centroid)\b", src)
        if geo_op and not re.search(r"\b(to_crs|set_crs|crs\s*=)", src):
            ln = src[: geo_op.start()].count("\n") + 1
            out.append(Finding(
                "warn", "earth · crs",
                "Geometric operation without a set CRS",
                ctx.snippet(ln)
                + "\n  .distance/.area/.buffer on a GeoDataFrame with no "
                "to_crs()/set_crs() — degrees are not meters; set a projected CRS.",
            ))
    return out


def _crs_finding(ctx: Ctx, node: ast.AST) -> Finding:
    return Finding(
        "error", "earth · crs",
        "Euclidean distance on latitude/longitude",
        ctx.snippet(ctx.line_of(node))
        + "\n  lat/lon are angles on a sphere, not planar coordinates — "
        "Euclidean/Pythagorean distance is wrong. Use the haversine formula "
        "or a geodesic (e.g. project to a metric CRS, or geopy.distance).",
    )


def _is_sq_diff(node: ast.AST) -> bool:
    """Matches (a - b) ** 2."""
    return (
        isinstance(node, ast.BinOp)
        and isinstance(node.op, ast.Pow)
        and isinstance(node.right, ast.Constant)
        and node.right.value == 2
        and isinstance(node.left, ast.BinOp)
        and isinstance(node.left.op, ast.Sub)
    )


# --------------------------------------------------------------------------- #
# Registry + driver
# --------------------------------------------------------------------------- #

VALIDATORS = [check_physics, check_earth]

_CODE_EXT = {".py": "python", ".r": "r", ".R": "r"}


def _build_ctx(path: str, src: str, lang: str) -> Ctx:
    ctx = Ctx(path=path, src=src, lang=lang, lines=src.splitlines())
    if lang == "python":
        try:
            ctx.tree = ast.parse(src)
        except SyntaxError:
            ctx.tree = None
    return ctx


def contexts_for(path: Path) -> list[Ctx]:
    """One or more code contexts from a file (a notebook yields one per file)."""
    suffix = path.suffix
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    if suffix == ".ipynb":
        return [_notebook_ctx(str(path), raw)]
    lang = _CODE_EXT.get(suffix)
    if not lang:
        return []
    return [_build_ctx(str(path), raw, lang)]


def _notebook_ctx(path: str, raw: str) -> Ctx:
    try:
        nb = json.loads(raw)
    except json.JSONDecodeError:
        return _build_ctx(path, "", "python")
    lang = "python"
    ks = nb.get("metadata", {}).get("kernelspec", {})
    if str(ks.get("language", "")).lower().startswith("r"):
        lang = "r"
    code = "\n".join(
        "".join(c.get("source", []))
        for c in nb.get("cells", [])
        if c.get("cell_type") == "code"
    )
    return _build_ctx(path, code, lang)


def analyze(ctx: Ctx) -> list[Finding]:
    out: list[Finding] = []
    seen: set[tuple[str, str, str]] = set()
    for validator in VALIDATORS:
        try:
            found = validator(ctx)
        except Exception:  # a buggy rule must never crash the whole gate
            continue
        for f in found:  # dedupe rules that overlap on one expression
            key = (f.tag, f.title, f.evidence)
            if key not in seen:
                seen.add(key)
                out.append(f)
    return out


def discover(root: Path) -> list[Path]:
    skip = {"node_modules", "__pycache__", ".git", ".openscience", ".venv", "venv"}
    out: list[Path] = []
    for p in sorted(root.rglob("*")):
        if any(part in skip or part.startswith(".") for part in p.parts):
            continue
        if p.is_file() and (p.suffix in _CODE_EXT or p.suffix == ".ipynb"):
            out.append(p)
    return out


NOTE = (
    "Domain-correctness gate — flags known dangerous patterns per discipline "
    "(units, CRS, coordinates). It checks for specific error classes only; "
    "absence of findings is not a guarantee the science is correct."
)


def run(paths: list[str]) -> dict:
    targets: list[Path] = []
    if paths:
        targets = [Path(p) for p in paths]
    else:
        targets = discover(Path.cwd())
    findings: list[Finding] = []
    for t in targets:
        for ctx in contexts_for(t):
            findings.extend(analyze(ctx))
    return {
        "findings": [
            {"level": f.level, "check": "domain", "tag": f.tag,
             "title": f.title, "evidence": f.evidence}
            for f in findings
        ],
        "note": NOTE,
    }


def main(argv: list[str]) -> int:
    result = run(argv[1:])
    print("```review")
    print(json.dumps(result, ensure_ascii=False))
    print("```")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
