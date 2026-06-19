# Models

Place the **CTranslate2 Faster-Whisper** model used by `transcript-service` here:

```
models/biodatlab-th-small-ct2/
```

This directory is mounted into the container at `/app/models` (so the model
resolves to `/app/models/biodatlab-th-small-ct2`, the default `MODEL_PATH`).

## Required files

A CTranslate2 Whisper model directory usually contains:

- `model.bin`               ← the CTranslate2 weights (large; git-ignored)
- `config.json`
- `tokenizer.json`
- `preprocessor_config.json`
- `vocabulary.json` (or `vocabulary.txt`)

## Important

The large binary weights (`model.bin`, `*.bin`, `*.onnx`, `*.pt`, `*.safetensors`)
are **git-ignored** on purpose — do not commit them unless this repo is
intentionally set up to version model files. Only this `README.md` and
`.gitkeep` are tracked, so the folder structure is preserved.

If `transcript-service` reports `model.bin not found`, the model has not been
placed here yet.
