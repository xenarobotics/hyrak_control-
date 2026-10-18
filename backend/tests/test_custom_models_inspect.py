"""
Custom models, the checker (docs/custom_models/DESIGN.md section 0):

  * the error table: every failure has plain words and a fix;
  * inspection in the runner process: task and layout inference, labels
    from Ultralytics metadata, Hugging Face config.json and a labels file,
    input layouts and sizes, and every refusal (wrong format, several
    inputs, custom operators, missing external data, opset too new,
    segmentation, unreadable outputs, non-image inputs);
  * the test run: latency, a preview with boxes, decoded results;
  * Hugging Face link parsing;
  * the migration as offline SQL.

The models are tiny ONNX graphs built in the test (custom_model_fixtures),
run on the CPU.
"""
import json
import os
import pickle
import subprocess
import sys
import zipfile
from pathlib import Path

import numpy as np
import pytest

from custom_model_fixtures import (  # noqa: E402
    NAMES3, classify_output, e2e_output, make_model, ultra_meta, yolov5_output, yolov8_output,
)
from app.config import get_settings
from app.models_custom import checks, hf
from app.models_custom.errors import KNOWN_FAILURES, ModelFailure, check_filename, describe

from onnx import TensorProto  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def cpu_only(monkeypatch):
    monkeypatch.setattr(get_settings(), "custom_models_use_gpu", False)


async def inspect_err(path, **kw) -> ModelFailure:
    with pytest.raises(ModelFailure) as e:
        await checks.inspect(Path(path), **kw)
    return e.value


# ── the error table ──────────────────────────────────────────────────────

def test_every_failure_has_words_and_a_fix():
    for code, (msg, hint) in KNOWN_FAILURES.items():
        assert msg and hint, code
        assert "\u2014" not in msg + hint, f"em-dash in {code}"
        assert msg.rstrip().endswith((".", ")")), code
    # The extras fill the message; a missing one never raises.
    assert describe("multiple_inputs", {"count": 3, "names": ["a", "b", "c"]})[0] == \
        "The model expects 3 inputs (a, b, c); HYRAK models need one image input."
    assert "?" in describe("multiple_inputs", {})[0]
    assert describe("no-such-code")[0] == KNOWN_FAILURES["load_failed"][0]
    f = ModelFailure("pytorch_file", "x")
    assert set(f.public()) == {"code", "error", "hint", "detail"}
    assert "yolo export" in f.hint


@pytest.mark.parametrize("name,code", [
    ("best.pt", "pytorch_file"), ("w.PTH", "pytorch_file"), ("m.pkl", "pickle_file"),
    ("model.safetensors", "safetensors_file"), ("m.tflite", "tflite_file"),
    ("m.engine", "tensorrt_file"), ("bundle.zip", "archive_file"), ("notes.txt", "wrong_extension"),
])
def test_files_refused_by_name(name, code):
    with pytest.raises(ModelFailure) as e:
        check_filename(name)
    assert e.value.code == code
    check_filename("good.onnx")


# ── inspection: tasks, layouts, labels ───────────────────────────────────

async def test_ultralytics_yolov8_detect_with_names(tmp_path):
    p = make_model(tmp_path / "m.onnx", {"output0": yolov8_output()}, metadata=ultra_meta())
    info = await checks.inspect(p)
    assert info["task"] == "detect" and info["head"]["layout"] == "yolov8"
    assert info["labels"] == ["person", "crack", "car"] and info["label_source"] == "ultralytics"
    assert info["input_size"] == [64, 64] and info["preprocess"]["resize"] == "letterbox"
    assert info["provider"] == "cpu" and info["opset"] == 13


async def test_yolov5_end_to_end_rtdetr_and_detr_layouts(tmp_path):
    info = await checks.inspect(make_model(tmp_path / "v5.onnx", {"out": yolov5_output()}))
    assert info["head"]["layout"] == "yolov5" and info["head"]["classes"] == 3
    assert info["labels"] == ["class 0", "class 1", "class 2"]

    info = await checks.inspect(make_model(tmp_path / "e2e.onnx", {"out": e2e_output()}))
    assert info["head"]["layout"] == "e2e"

    rt = np.zeros((1, 300, 4 + 5), np.float32)
    info = await checks.inspect(make_model(tmp_path / "rt.onnx", {"out": rt}))
    assert info["head"]["layout"] == "rtdetr" and info["head"]["classes"] == 5

    # Hugging Face DETR: logits (with the no-object class) and pred_boxes.
    p = make_model(tmp_path / "detr.onnx", {"logits": np.zeros((1, 100, 4), np.float32),
                                           "pred_boxes": np.zeros((1, 100, 4), np.float32)})
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"architectures": ["DetrForObjectDetection"],
                               "id2label": {"0": "cat", "1": "dog", "2": "bird"}}))
    info = await checks.inspect(p, config=cfg)
    assert info["head"]["layout"] == "detr" and info["head"]["softmax"] is True
    assert info["labels"] == ["cat", "dog", "bird"] and info["label_source"] == "huggingface"
    assert info["preprocess"]["mean"] is not None


async def test_classifier_with_hf_config_and_labels_file_override(tmp_path):
    p = make_model(tmp_path / "c.onnx", {"logits": classify_output()}, input_shape=(1, 3, 224, 224))
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"architectures": ["ViTForImageClassification"],
                               "id2label": {"0": "ok", "1": "crack", "2": "rust"}}))
    pre = tmp_path / "pre.json"
    pre.write_text(json.dumps({"image_mean": [0.5, 0.5, 0.5], "image_std": [0.5, 0.5, 0.5],
                               "size": {"height": 224, "width": 224}}))
    info = await checks.inspect(p, config=cfg, preprocessor=pre)
    assert info["task"] == "classify" and info["labels"] == ["ok", "crack", "rust"]
    assert info["preprocess"]["mean"] == [0.5, 0.5, 0.5]
    info = await checks.inspect(p, config=cfg, labels=["a", "b", "c"])
    assert info["labels"] == ["a", "b", "c"] and info["label_source"] == "file"


async def test_dynamic_size_nhwc_and_uint8_inputs(tmp_path):
    p = make_model(tmp_path / "dyn.onnx", {"output0": yolov8_output()},
                   input_shape=("batch", 3, "h", "w"), metadata=ultra_meta(imgsz="[320, 320]"))
    info = await checks.inspect(p)
    assert info["input_size"] == [320, 320] and info["input_size_source"] == "ultralytics"
    p = make_model(tmp_path / "dyn2.onnx", {"probs": classify_output()},
                   input_shape=(1, 3, "h", "w"))
    assert (await checks.inspect(p))["input_size"] == [224, 224]
    p = make_model(tmp_path / "nhwc.onnx", {"output0": yolov8_output()}, input_shape=(1, 64, 64, 3),
                   input_type=TensorProto.UINT8)
    info = await checks.inspect(p)
    assert info["input"]["layout"] == "nhwc" and info["input"]["dtype"] == "uint8"
    assert info["preprocess"]["scale"] == 1.0


async def test_named_channel_axis_is_colour_nchw(tmp_path):
    """Hugging Face / PyTorch exports name every axis, channels included
    (Xenova/yolos-tiny: ["batch_size", "num_channels", "height", "width"])."""
    p = make_model(tmp_path / "hf.onnx", {"probs": classify_output()},
                   input_shape=("batch_size", "num_channels", "height", "width"))
    info = await checks.inspect(p)
    assert info["input"]["layout"] == "nchw" and info["input"]["channels"] == 3


async def test_label_count_mismatch_is_a_warning_not_a_failure(tmp_path):
    p = make_model(tmp_path / "m.onnx", {"output0": yolov8_output(n_classes=4)},
                   metadata=ultra_meta(names="{0: 'a', 1: 'b'}"))
    info = await checks.inspect(p)
    assert info["labels"] == ["a", "b", "class 2", "class 3"]
    assert any("classes" in w for w in info["warnings"])


# ── inspection: refusals ─────────────────────────────────────────────────

async def test_non_onnx_files_are_named(tmp_path):
    pt = tmp_path / "best.onnx"                 # a .pt renamed: the bytes decide
    with zipfile.ZipFile(pt, "w") as z:
        z.writestr("archive/data.pkl", b"\x80\x02}q\x00.")
    assert (await inspect_err(pt)).code == "pytorch_file"
    pk = tmp_path / "p.onnx"
    pk.write_bytes(pickle.dumps({"a": 1}, protocol=4))
    assert (await inspect_err(pk)).code == "pickle_file"
    st = tmp_path / "s.onnx"
    header = b'{"w": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}'
    st.write_bytes(len(header).to_bytes(8, "little") + header + b"\0\0\0\0")
    assert (await inspect_err(st)).code == "safetensors_file"
    junk = tmp_path / "j.onnx"
    junk.write_bytes(b"this is not a model at all" * 10)
    assert (await inspect_err(junk)).code == "not_onnx"
    empty = tmp_path / "e.onnx"
    empty.write_bytes(b"")
    assert (await inspect_err(empty)).code == "empty_file"


async def test_graph_refusals(tmp_path):
    f = await inspect_err(make_model(tmp_path / "two.onnx", {"o": yolov8_output()}, extra_inputs=1))
    assert f.code == "multiple_inputs" and f.extra["count"] == 2
    assert "2 inputs (images, extra0)" in f.message

    f = await inspect_err(make_model(tmp_path / "cu.onnx", {"o": yolov8_output()},
                                     custom_domain="com.acme"))
    assert f.code == "custom_ops" and "com.acme" in f.message

    f = await inspect_err(make_model(tmp_path / "new.onnx", {"o": yolov8_output()}, opset=99))
    assert f.code == "opset_too_new" and "opset 99" in f.message

    f = await inspect_err(make_model(tmp_path / "seg.onnx", {"o": yolov8_output()},
                                     metadata=ultra_meta(task="segment")))
    assert f.code == "task_unsupported" and "segment" in f.message

    f = await inspect_err(make_model(tmp_path / "odd.onnx", {"o": np.zeros((1, 2, 3), np.float32)}))
    assert f.code == "unknown_layout"

    f = await inspect_err(make_model(tmp_path / "flat.onnx", {"o": yolov8_output()},
                                     input_shape=(1, 4096)))
    assert f.code == "input_not_image"

    f = await inspect_err(make_model(tmp_path / "b4.onnx", {"o": yolov8_output()},
                                     input_shape=(4, 3, 64, 64)))
    assert f.code == "dynamic_input"

    f = await inspect_err(make_model(tmp_path / "i64.onnx", {"o": yolov8_output()},
                                     input_type=TensorProto.INT64))
    assert f.code == "input_dtype"


async def test_external_weights_must_sit_next_to_the_model(tmp_path):
    d = tmp_path / "ext"
    d.mkdir()
    p = make_model(d / "m.onnx", {"output0": yolov8_output()}, metadata=ultra_meta(),
                   external_weights=True)
    assert (await checks.inspect(p))["task"] == "detect"
    os.unlink(d / "weights.bin")
    f = await inspect_err(p)
    assert f.code == "external_data_missing" and "weights.bin" in f.message


async def test_a_hanging_or_crashing_checker_is_contained(tmp_path, monkeypatch):
    p = make_model(tmp_path / "m.onnx", {"output0": yolov8_output()})
    monkeypatch.setattr(checks, "runner_command",
                        lambda mode, *a: [sys.executable, "-c", "import time; time.sleep(30)"])
    monkeypatch.setattr(get_settings(), "custom_models_inspect_timeout_s", 1.0)
    f = await inspect_err(p)
    assert f.code == "timeout" and "1 seconds" in f.message
    monkeypatch.setattr(checks, "runner_command",
                        lambda mode, *a: [sys.executable, "-c", "import os; os.abort()"])
    assert (await inspect_err(p)).code == "crashed"


# ── the test run ─────────────────────────────────────────────────────────

async def test_test_run_measures_and_draws_a_preview(tmp_path):
    p = make_model(tmp_path / "m.onnx", {"output0": yolov8_output()}, metadata=ultra_meta())
    info = await checks.inspect(p)
    res = await checks.test(p, info, preview=tmp_path / "preview.jpg")
    assert res["provider"] == "cpu" and res["latency_ms"] > 0 and res["fps"] > 0
    assert res["samples"] and all(s["found"] == 1 for s in res["samples"])
    assert (tmp_path / "preview.jpg").stat().st_size > 1000

    c = make_model(tmp_path / "c.onnx", {"probs": classify_output()}, input_shape=(1, 3, 224, 224),
                   metadata=ultra_meta(task="classify"))
    info = await checks.inspect(c)
    res = await checks.test(c, info, preview=tmp_path / "c.jpg")
    assert res["samples"][0]["top"][0] == {"name": "crack", "score": pytest.approx(0.7)}


def test_bundled_sample_frames_exist():
    frames = checks.sample_frames()
    assert frames and all(Path(f).is_file() for f in frames)
    assert len(list(checks.SAMPLES.glob("*.jpg"))) >= 2


def test_runner_decodes_boxes_into_frame_pixels(tmp_path):
    """The decode itself, in-process: a box placed at the centre of a 64 px
    input comes back at the centre of a 128 px frame, labelled."""
    sys.path.insert(0, str(checks.RUNNER.parent))
    try:
        import runner as r
    finally:
        sys.path.pop(0)
    p = make_model(tmp_path / "m.onnx", {"output0": yolov8_output()}, metadata=ultra_meta())
    out = subprocess.run(checks.runner_command("inspect"), input=json.dumps(
        {"model": str(p), "use_gpu": False}), capture_output=True, text=True, timeout=60)
    info = json.loads(out.stdout.strip().splitlines()[-1])["info"]
    m = r.Model(str(p), info, use_gpu=False)
    res = m.run(np.zeros((128, 128, 3), np.uint8), 0.25)
    assert res == {"task": "detect", "detections": [
        {"class_id": 1, "score": 0.9, "box": [44, 44, 84, 84]}]}
    assert r.label_of(info["labels"], 1) == "crack"
    assert NAMES3


# ── Hugging Face links ───────────────────────────────────────────────────

@pytest.mark.parametrize("text,repo", [
    ("Xenova/yolos-tiny", "Xenova/yolos-tiny"),
    ("https://huggingface.co/Xenova/yolos-tiny", "Xenova/yolos-tiny"),
    ("https://huggingface.co/Xenova/yolos-tiny/tree/main/onnx", "Xenova/yolos-tiny"),
    ("hf.co/onnx-community/rtdetr_r18vd?x=1", "onnx-community/rtdetr_r18vd"),
])
def test_hf_repo_links(text, repo):
    assert hf.parse_repo(text) == repo


@pytest.mark.parametrize("text", ["", "justaname", "https://github.com/a/b",
                                  "https://huggingface.co/datasets/a/b", "a/../b", "a/b c"])
def test_hf_bad_links(text):
    with pytest.raises(ModelFailure) as e:
        hf.parse_repo(text)
    assert e.value.code == "hf_bad_repo"


# ── migration ────────────────────────────────────────────────────────────

def _alembic_sql(*args) -> str:
    env = {**os.environ, "DATABASE_URL": "postgresql+asyncpg://offline@localhost/offline_only"}
    out = subprocess.run([sys.executable, "-m", "alembic", *args, "--sql"], cwd=BACKEND, env=env,
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    return out.stdout


def test_migration_chain_and_sql():
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    script = ScriptDirectory.from_config(Config(str(BACKEND / "alembic.ini")))
    rev = script.get_revision("d1e2f3a4b5c6")
    assert rev.down_revision == "a7d3e9b1c4f2"
    # Later migrations build on it (e2f3a4b5c6d7: map_sightings).
    assert len(script.get_heads()) == 1
    up = _alembic_sql("upgrade", "a7d3e9b1c4f2:d1e2f3a4b5c6")
    assert "CREATE TABLE models (" in up and "CREATE TABLE model_versions (" in up
    assert "FOREIGN KEY(workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE" in up
    assert "FOREIGN KEY(model_id) REFERENCES models (id) ON DELETE CASCADE" in up
    assert "CONSTRAINT uq_model_versions_model_n UNIQUE (model_id, n)" in up
    assert "CREATE INDEX ix_models_workspace_id ON models (workspace_id)" in up
    assert "published_version INTEGER," in up and "catalogue JSONB," in up
    down = _alembic_sql("downgrade", "d1e2f3a4b5c6:a7d3e9b1c4f2")
    assert "DROP TABLE model_versions" in down and "DROP TABLE models" in down
    assert down.index("DROP TABLE model_versions") < down.index("DROP TABLE models")
