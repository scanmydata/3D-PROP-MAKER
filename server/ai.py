"""AI assistant: describe photos and plan 3D props with a vision LLM.

Works with any OpenAI-compatible chat API:
  * OpenRouter (cloud) - prefers free (":free", zero-price) models that accept images
  * LM Studio / Ollama / Strata / llama.cpp server (local)
"""
from __future__ import annotations

import base64
import io
import json
import re
import time

import requests
from PIL import Image

import config
import resources

PROP_CATEGORIES = [
    "banner", "traffic_cone", "tire_wall", "armco", "kerb", "concrete_wall", "fence", "building", "tree",
    "pole", "street_lamp", "sign", "flag", "tent", "grandstand", "box", "cylinder", "road", "other",
]

DESCRIBE_PROMPT = """You are helping build 3D models of race tracks and track-side props from photos.
Look at the image(s) and answer ONLY with one JSON object, no markdown, in this exact shape:
{{
  "summary": "<2-4 sentences in {lang} describing what is shown>",
  "scene_type": "prop" | "track" | "building" | "street" | "other",
  "objects": [
    {{
      "name": "<short name in {lang}>",
      "category": one of {cats},
      "count": <integer>,
      "dimensions_m": {{"width": <number>, "height": <number>, "depth": <number>}},
      "color": "<main colour as #rrggbb>",
      "material": "<e.g. PVC, concrete, steel, rubber, glass, brick>",
      "text_on_it": "<visible text or logo, or empty>",
      "notes": "<anything useful for modelling, in {lang}>"
    }}
  ],
  "capture_advice": "<in {lang}: how to photograph this for photogrammetry, or empty>"
}}
Estimate real-world sizes in meters from context (people ~1.75 m, cars ~4.5 m long, lanes ~3.5 m wide).
List the main objects first, at most 15. {extra}"""


def _provider(cfg: dict) -> tuple[str, str, dict]:
    name = cfg.get("ai_provider") or "openrouter"
    info = config.AI_PROVIDERS.get(name, config.AI_PROVIDERS["custom"])
    base = (cfg.get("ai_base_url") or info["base_url"]).rstrip("/")
    headers = {"Content-Type": "application/json"}
    if cfg.get("ai_api_key"):
        headers["Authorization"] = f"Bearer {cfg['ai_api_key']}"
    if name == "openrouter":
        # Optional attribution headers OpenRouter documents; generic app name only.
        headers["X-Title"] = "Track & Props Studio"
    return name, base, headers


def _is_free(m: dict) -> bool:
    p = m.get("pricing") or {}
    return m.get("id", "").endswith(":free") or (str(p.get("prompt", "1")) in ("0", "0.0") and str(p.get("completion", "1")) in ("0", "0.0"))


def list_models(cfg: dict | None = None, provider: str | None = None) -> list[dict]:
    cfg = dict(cfg or config.load())
    if provider:
        cfg["ai_provider"] = provider
    name, base, headers = _provider(cfg)
    r = requests.get(f"{base}/models", headers=headers, timeout=20)
    r.raise_for_status()
    data = r.json().get("data", [])
    out = []
    for m in data:
        mods = (m.get("architecture") or {}).get("input_modalities") or []
        vision = "image" in mods if mods else None  # local servers don't say
        if name == "openrouter":
            outs = (m.get("architecture") or {}).get("output_modalities") or ["text"]
            if not _is_free(m) or outs != ["text"]:  # skip music / image generators
                continue
        out.append({"id": m["id"], "name": m.get("name") or m["id"], "vision": vision, "free": _is_free(m) if name == "openrouter" else True,
                    "context": m.get("context_length")})
    # Vision models first, then by context size.
    out.sort(key=lambda m: (m["vision"] is not True, -(m["context"] or 0)))
    return out


def _pick_models(cfg: dict) -> list[str]:
    if cfg.get("ai_model"):
        models = [cfg["ai_model"]]
    else:
        models = []
    if (cfg.get("ai_provider") or "openrouter") == "openrouter":
        # Fall back through other free vision models when one is rate-limited or offline.
        try:
            models += [m["id"] for m in list_models(cfg) if m["vision"] and m["id"] not in models and m["id"] != "openrouter/free"][:4]
        except Exception:  # noqa: BLE001
            pass
        if not models:
            models = ["openrouter/free"]
    elif not models:
        try:
            models = [list_models(cfg)[0]["id"]]
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"No model loaded in the local AI server ({exc}). Load one in LM Studio / Ollama first.") from exc
    return models


def _image_part(data: bytes, max_side: int = 1280) -> dict:
    img = Image.open(io.BytesIO(data))
    img = img.convert("RGB")
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()}}


def chat(messages: list, cfg: dict | None = None, max_tokens: int = 1800, json_mode: bool = True) -> tuple[str, str]:
    cfg = cfg or config.load()
    if not cfg.get("ai_enabled"):
        raise RuntimeError("The AI assistant is off. Turn it on in Settings → AI.")
    name, base, headers = _provider(cfg)
    if name == "openrouter" and not cfg.get("ai_api_key"):
        raise RuntimeError("OpenRouter needs a (free) API key: openrouter.ai → Keys. Paste it in Settings → AI.")
    local = config.AI_PROVIDERS.get(name, {}).get("local", True)
    if local and cfg.get("ai_local_during_gpu", "wait") == "wait" and resources.gpu_busy():
        # Same GPU / RAM as Spirula: let the reconstruction stage finish first.
        if not resources.wait_for_gpu_idle(timeout=1800):
            raise RuntimeError("Local AI is waiting for a reconstruction to finish (Settings → Resources).")
    errors = []
    for model in _pick_models(cfg):
        body = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": 0.2}
        if json_mode and name in ("openrouter", "lmstudio", "ollama"):
            body["response_format"] = {"type": "json_object"} if name != "lmstudio" else {"type": "text"}
        for attempt in range(2):
            try:
                r = requests.post(f"{base}/chat/completions", headers=headers, json=body, timeout=300 if local else 120)
            except requests.RequestException as exc:
                raise RuntimeError(f"Cannot reach the AI server at {base} ({exc}). Is it running?") from exc
            if r.status_code == 400 and "response_format" in body:
                body.pop("response_format")  # some models/servers reject it
                continue
            if r.status_code == 429 and attempt == 0:
                time.sleep(3)
                continue
            break
        if r.status_code != 200:
            errors.append(f"{model}: HTTP {r.status_code} {r.text[:200]}")
            continue
        msg = (r.json().get("choices") or [{}])[0].get("message") or {}
        text = msg.get("content") or ""
        if isinstance(text, list):
            text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
        if text.strip():
            return text, model
        errors.append(f"{model}: empty answer")
    raise RuntimeError("AI request failed: " + " | ".join(errors[-3:]))


def parse_json(text: str) -> dict:
    t = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    t = re.sub(r"<think>.*?</think>", "", t, flags=re.S).strip()
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in the answer")
    return json.loads(t[start:end + 1])


def describe_images(images: list[bytes], extra: str = "", cfg: dict | None = None) -> dict:
    cfg = cfg or config.load()
    lang = cfg.get("ai_language") or "English"
    prompt = DESCRIBE_PROMPT.format(lang=lang, cats=json.dumps(PROP_CATEGORIES), extra=extra.strip())
    content = [{"type": "text", "text": prompt}] + [_image_part(b) for b in images[:6]]
    text, model = chat([{"role": "user", "content": content}], cfg)
    try:
        data = parse_json(text)
    except Exception:  # noqa: BLE001
        data = {"summary": text.strip(), "objects": [], "parse_error": True}
    data.setdefault("objects", [])
    data["model"] = model
    return data


def test(cfg: dict | None = None) -> dict:
    text, model = chat([{"role": "user", "content": 'Reply with {"ok": true} only.'}], cfg, max_tokens=50)
    return {"model": model, "answer": text[:200]}
