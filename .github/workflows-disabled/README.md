# Disabled GitHub Actions (local OCR)

Open Code Review on this machine uses the local CLI + local model
(`ocr` → `http://127.0.0.1:1234/v1`, model `qwen/qwen2.5-coder-14b`).

These workflows were moved out of `.github/workflows/` so they do not fire
on every PR / weekly schedule without cloud LLM secrets or a self-hosted runner.

To re-enable CI reviews later:
1. Move `ocr-review.yml` / `ocr-full-scan.yml` back into `.github/workflows/`
2. Set `OCR_LLM_*` secrets/vars, or point `runs-on` at a self-hosted runner that can reach the local model
