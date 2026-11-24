#!/usr/bin/env python3
"""
Synthesize Chinese tutorial voiceover lines using Qwen3-TTS official preset speaker 'Serena'.
Reads <vo_dir>/lines.json and writes mono 24kHz PCM16 WAVs to <vo_dir>/raw/<id>.wav.

Usage:
  /Users/user/VoiceTTS/.venv/bin/python gen_tts_serena.py --smoke /tmp/serena_smoke.wav
  /Users/user/VoiceTTS/.venv/bin/python gen_tts_serena.py <vo_dir> [<vo_dir> ...]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
import wave
from pathlib import Path

import mlx.core as mx
import numpy as np

MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
CACHE_GLOB = os.path.expanduser(
    "~/.cache/huggingface/hub/models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit/snapshots/*"
)
SPEAKER = "serena"
LANGUAGE = "Chinese"


def find_local_model_path() -> str:
    snaps = sorted(glob.glob(CACHE_GLOB))
    for s in snaps:
        if os.path.isfile(os.path.join(s, "config.json")):
            return s
    return MODEL_ID


def load_tts_model():
    from mlx_audio.tts.utils import load_model

    model_ref = find_local_model_path()
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    print(f"[Serena TTS] Loading model from: {model_ref}", flush=True)
    return load_model(model_ref)


def write_wav_pcm16(out_path: Path, audio_arr, sample_rate: int = 24000) -> float:
    arr = np.asarray(audio_arr, dtype=np.float32).reshape(-1)
    peak = float(np.max(np.abs(arr))) if arr.size else 0.0
    if peak > 0.99:
        arr = arr * (0.98 / peak)
    pcm16 = np.clip(arr * 32767.0, -32768.0, 32767.0).astype("<i2")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm16.tobytes())
    return float(len(pcm16)) / float(sample_rate)


def synth_one(model, text: str, out_wav: Path, instruct: str | None = None) -> float:
    kwargs = {"text": text, "speaker": SPEAKER, "language": LANGUAGE}
    if instruct:
        kwargs["instruct"] = instruct
    last_err = None
    for attempt in range(2):
        chunks = []
        sr = 24000
        try:
            for res in model.generate_custom_voice(**kwargs):
                sr = int(getattr(res, "sample_rate", 24000) or 24000)
                chunks.append(np.asarray(res.audio, dtype=np.float32).reshape(-1))
            if not chunks:
                raise RuntimeError(f"Empty audio returned for text: {text!r}")
            full = np.concatenate(chunks, axis=0)
            dur = write_wav_pcm16(out_wav, full, sr)
            try:
                mx.clear_cache()
            except Exception:
                pass
            time.sleep(0.25)
            return dur
        except RuntimeError as e:
            last_err = e
            try:
                mx.clear_cache()
            except Exception:
                pass
            if attempt == 0:
                print(f"  [retry] transient MLX error on {out_wav.name}: {e}", flush=True)
                time.sleep(1.5)
    raise last_err


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", help="Synthesize one smoke WAV to this path")
    ap.add_argument("--force", action="store_true", help="Overwrite existing raw/*.wav files")
    ap.add_argument("vo_dirs", nargs="*", help="One or more vo/main directories containing lines.json")
    args = ap.parse_args()

    model = load_tts_model()

    if args.smoke:
        out_p = Path(args.smoke)
        dur = synth_one(
            model,
            "大家好，我是外部客服工作台教程讲解员。这一步我们一起来核对现货实拍照片与通电试机视频。",
            out_p,
        )
        print(f"[Serena TTS] Smoke OK: {out_p} ({dur:.2f}s)", flush=True)
        return 0

    if not args.vo_dirs:
        ap.print_help()
        return 1

    for vo_dir_str in args.vo_dirs:
        vo_dir = Path(vo_dir_str)
        lines_path = vo_dir / "lines.json"
        if not lines_path.is_file():
            raise FileNotFoundError(f"Missing lines.json: {lines_path}")
        lines = json.loads(lines_path.read_text(encoding="utf-8"))
        raw_dir = vo_dir / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        print(f"[Serena TTS] Directory {vo_dir} ({len(lines)} lines)", flush=True)
        for item in lines:
            lid = item["id"]
            tts_text = item.get("tts") or item["text"]
            out_wav = raw_dir / f"{lid}.wav"
            if out_wav.is_file() and out_wav.stat().st_size > 1000 and not args.force:
                print(f"  [skip] {lid}.wav exists")
                continue
            dur = synth_one(model, tts_text, out_wav, instruct=item.get("instruct"))
            print(f"  [ok] {lid}.wav -> {dur:.2f}s | {tts_text[:36]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
