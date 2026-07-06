---
name: modal-run
description: Use when the user asks to run heavy or GPU work on Modal (the cloud compute platform) — writing a Modal function in the workspace, running it with the user's own `modal` CLI + token, and bringing results back. Data-to-compute for jobs too big for the laptop, without a Slurm cluster.
---

# Run compute on Modal

Modal runs code in the cloud on demand (CPU/GPU), billed to the **user's own**
Modal account. Like the HPC/Slurm path, the app never handles credentials — you
use the user's installed `modal` CLI and their token. Prefer local execution or
Slurm first; reach for Modal when the job needs cloud GPUs or elastic scale and
no cluster is available.

## 1 · Check Modal is ready

Modal must be installed and authenticated (the Settings **Cloud compute (Modal)**
card shows this). Verify before writing code:

```bash
modal --version          # installed?
test -f ~/.modal.toml && echo "authenticated" || echo "run: modal token new"
```

If it is not installed, tell the user to `pip install modal`; if not
authenticated, ask them to run `modal token new` in their terminal (it opens a
browser). Do **not** attempt to create or store tokens yourself.

## 2 · Write the Modal function into the workspace

Put the script in the workspace so provenance records it. Pin dependencies in
the image so the run is reproducible, and fix any random seed.

```python
# compute.py — run with:  modal run compute.py
import modal

app = modal.App("open-science-job")
image = modal.Image.debian_slim().pip_install("numpy==1.26.4", "scipy==1.13.1")

@app.function(image=image, gpu=None, timeout=1800)  # set gpu="A10G" etc. if needed
def run(n: int = 1_000_000):
    import numpy as np
    rng = np.random.default_rng(0)          # fixed seed → reproducible
    x = rng.standard_normal(n)
    return {"n": n, "mean": float(x.mean()), "std": float(x.std())}

@app.local_entrypoint()
def main():
    result = run.remote()
    print(result)                            # printed locally; capture it below
```

## 3 · Run it and capture the result

`modal run` executes remotely and streams logs + the local entrypoint's stdout
back. Write the result into the workspace so it becomes a traceable artifact:

```bash
modal run compute.py | tee modal_result.txt
```

For large outputs, have the function write to a Modal Volume and download with
`modal volume get`, rather than returning big objects.

## Rules

- **User's account only.** Never handle, print, or store Modal tokens.
- **Reproducible.** Pin image packages and fix seeds; record the script + result
  in the workspace (provenance captures them).
- **Cost-aware.** Modal bills the user — keep `timeout` bounded, don't request a
  GPU unless the work needs one, and say what you're about to run before a large
  job.
