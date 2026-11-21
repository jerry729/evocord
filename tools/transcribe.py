#!/usr/bin/env python3
"""Transcribe one audio/video file with faster-whisper and print JSON.

    .venv/bin/python tools/transcribe.py [--model large-v3-turbo] [--device auto]
        [--compute-type auto] [--language zh] [--initial-prompt TEXT] FILE

Output: {"text": ..., "language": ..., "duration": seconds, "device": ...}
Errors: {"error": ...} with a non-zero exit code.

Runs once per file. Discord voice messages are OGG/Opus; PyAV (bundled with
faster-whisper) decodes them without a system ffmpeg.
"""
import argparse
import glob
import json
import os
import sys


def _cuda_lib_dirs():
    # pip's nvidia-cublas-cu12 / nvidia-cudnn-cu12 put .so files in site-packages/nvidia/*/lib.
    dirs = []
    for base in sys.path:
        dirs += glob.glob(os.path.join(base, "nvidia", "*", "lib"))
    return sorted(set(dirs))


def _ensure_cuda_libs():
    """CTranslate2 dlopens cuBLAS/cuDNN by soname; the loader reads LD_LIBRARY_PATH only at exec."""
    if os.environ.get("_TRANSCRIBE_REEXEC"):
        return
    dirs = _cuda_lib_dirs()
    if not dirs:
        return
    current = os.environ.get("LD_LIBRARY_PATH", "")
    os.environ["LD_LIBRARY_PATH"] = ":".join(dirs + ([current] if current else []))
    os.environ["_TRANSCRIBE_REEXEC"] = "1"
    os.execv(sys.executable, [sys.executable] + sys.argv)


def pick_device(requested):
    if requested != "auto":
        return requested
    try:
        import ctranslate2
        return "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    except Exception:
        return "cpu"


def transcribe(path, model_name, device, compute_type, language, initial_prompt, max_seconds):
    from faster_whisper import WhisperModel

    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments, info = model.transcribe(
        path,
        language=language or None,
        initial_prompt=initial_prompt or None,
        vad_filter=True,
        beam_size=5,
    )
    if info.duration and info.duration > max_seconds:
        raise ValueError(f"audio is {info.duration:.0f}s, limit is {max_seconds}s")
    text = "".join(segment.text for segment in segments).strip()
    return {
        "text": text,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 2),
        "device": device,
        "model": model_name,
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("file")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--language", default=None)
    parser.add_argument("--initial-prompt", default=None)
    parser.add_argument("--max-seconds", type=float, default=900)
    args = parser.parse_args(argv)

    device = pick_device(args.device)
    try:
        try:
            result = transcribe(args.file, args.model, device, args.compute_type,
                                args.language, args.initial_prompt, args.max_seconds)
        except (RuntimeError, OSError) as exc:
            # Typical: CUDA present but cuDNN/cuBLAS missing or out of memory. Retry on CPU.
            if device != "cuda":
                raise
            print(f"transcribe: cuda failed ({exc}); retrying on cpu", file=sys.stderr)
            result = transcribe(args.file, args.model, "cpu", "int8",
                                args.language, args.initial_prompt, args.max_seconds)
    except Exception as exc:
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    _ensure_cuda_libs()
    sys.exit(main())
