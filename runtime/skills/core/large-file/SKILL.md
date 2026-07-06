---
name: large-file
description: Use BEFORE reading any data file that could be large (CSV/TSV, Parquet, HDF5, FITS, NetCDF, NDJSON, or big text/simulation logs like VASP OUTCAR). Returns a compact memory pointer — header/schema/shape/sample/key numbers — by introspection and sampling in bounded memory, so you never load a file bigger than the context window into the model. Reference data via the pointer; read specific ranges deterministically.
---

# Large files: reference, don't load

Scientific files routinely dwarf any context window (90 GB FASTQ, multi-GB
HDF5/FITS snapshots, 20 GB+ NetCDF rasters, huge VASP logs). Reading them raw
both OOMs and hallucinates — the materials case that consumed 20M+ tokens and
**failed** succeeded in ~1200 tokens with a memory-pointer approach.

**Rule: never `cat`/read a whole data file into your context.** Probe it first,
work from the returned pointer (schema + sample + key numbers), then read only
the specific rows/columns/ranges you need with the real library.

## Probe a file

The probe ships beside this SKILL.md. Run it on any data file **before** opening
it:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/large-file/large_file_probe.py" DATA_FILE [--sample N]
```

It prints one compact JSON pointer on stdout — always tiny, regardless of file
size (a 13 MB CSV → ~800 bytes; a 16 MB HDF5 → ~450 bytes).

## What you get back

- **Tables (CSV/TSV)** — column names + inferred dtypes, approximate row count
  (streamed, constant memory), and a head **and** tail sample.
- **Parquet** — schema + row/column/row-group counts, from file metadata only
  (no column data read).
- **HDF5** — the dataset tree with shapes and dtypes (no array data read).
- **FITS** — HDU list with dimensions and header keys (memmapped headers).
- **NetCDF** — dimensions and variables with dtypes.
- **NDJSON** — union of keys, record count, and a sample.
- **Text / logs** — line count and head/tail; scientific logs (VASP `OUTCAR`,
  `OSZICAR`) also get deterministic numeric extraction (e.g. final
  `free energy TOTEN`, `energy(sigma->0)`, convergence flag) — the numbers, not
  the prose.

Binary formats degrade gracefully: if the library (`pyarrow`/`h5py`/`astropy`/
`netCDF4`) isn't installed, the pointer says so with an install hint — it never
dumps raw bytes.

## Then read only what you need

Work from the pointer. When you need actual values, read a bounded slice with
the real library — never the whole file:

```python
import pandas as pd
df = pd.read_csv("big.csv", nrows=10_000)                 # a bounded window
df = pd.read_csv("big.csv", usecols=["id", "temp_c"])     # only needed columns
import pyarrow.parquet as pq
df = pq.read_table("big.parquet", columns=["val"]).to_pandas()
import h5py
with h5py.File("sim.h5") as h: block = h["density"][0:64, 0:64, :]  # a sub-array
```

Report which columns/ranges you read, so the analysis stays traceable.
