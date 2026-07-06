---
name: domain-check
description: Use whenever you write or run scientific analysis code (physics or earth/geo) in this workspace — before executing it and again after generating results. Runs a deterministic domain-correctness gate that catches code which runs but is scientifically wrong (unit/dimension mismatch, Euclidean distance on lat/lon without a CRS). Surfaces structured findings; never claims the code is correct.
---

# Domain-correctness gate

Across every field the top complaint is code that **executes cleanly but is
scientifically wrong**. This gate intercepts that field's classic error classes
**deterministically** — by analysing the code you actually wrote, not by
recalling rules. It verifies specific error classes; it never proves correctness.

Run it as a normal step of any analysis — it is fast, offline, and stdlib-only.

## When to run

- **Before executing** analysis code you generated (catch the bug before it
  produces a plausible-but-wrong number).
- **After generating results**, as a final gate before you report figures or
  numbers to the user.
- Whenever the user asks to check, validate, or audit an analysis for
  correctness.

## How to run

The gate ships beside this SKILL.md. Run it on the code files in play (or with
no arguments to scan the workspace):

```bash
python "$XDG_CONFIG_HOME/opencode/skills/domain-check/domain_check.py" <file.py|notebook.ipynb|analysis.R ...>
```

It prints exactly one ` ```review ` fenced JSON block on stdout.

## What it catches (one rule set per discipline)

- **physics · units** — adding/subtracting/comparing quantities of different
  dimensions (e.g. `t_seconds + d_meters`); trig on a degree-valued angle.
- **earth · crs** — Euclidean/Pythagorean distance on latitude/longitude
  (`sqrt((lat1-lat2)**2 + (lon1-lon2)**2)`); a geopandas geometric op with no
  CRS ever set.

Rules favour precision: an unrecognized unit, or arithmetic with no discipline
signal, is left silent rather than flagged.

## Reporting findings

Copy the ` ```review ` block the tool prints as the **last thing** in your
message — the app renders it as dismissible reviewer cards. Do not paraphrase
the findings into prose and drop the block; the structured block is the
contract. If the gate found nothing, say so plainly and keep the block (its
`note` states that no findings is not a guarantee of correctness).

Never tell the user the code is "correct" or "error-free" — the gate checks
known error classes only.

## Adding a discipline

Add a `check_<field>(ctx)` function in `domain_check.py` and append it to
`VALIDATORS`. No other change is needed — the review contract and the app's
rendering are discipline-agnostic (each finding carries its own `tag`).
