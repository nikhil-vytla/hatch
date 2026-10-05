# Notes

- Created folder `uv-hf-deps` with the pinned `requirements.txt` (datasets 3.5.0, torch 2.6.0, transformers 4.50.3).
- `uv venv` picked CPython 3.10.0; `uv pip install -r requirements.txt` resolved transitive deps (pandas, pyarrow, tokenizers, etc.).
- `.venv/` is local only; do not commit it.
