"""
The custom model runner: the only code that opens a customer's ONNX file.

It always runs as its own process (`python -I runner.py <mode>`), never
imported by the backend, so a malformed model that crashes onnxruntime,
leaks memory or hangs takes down this process and nothing else. It imports
nothing from `app` on purpose: started with -I it sees only the standard
library and site-packages, never the working directory.

Modes (docs/custom_models/DESIGN.md section 0, "Lifecycle"):

  inspect   stdin: {"model", "config"?, "preprocessor"?, "labels"?, "task"?,
            "use_gpu"}. Opens the file, checks it, infers the task and the
            output layout. stdout: one JSON line {"ok": true, "info": {...}}
            or {"ok": false, "code", "detail"}.
  test      stdin: {"spec": <inspect info + labels/threshold>, "model",
            "samples": [jpg, ...], "preview": out.jpg, "use_gpu"}. Runs the
            model on the sample frames: latency, GPU memory, a preview with
            boxes. stdout: {"ok": true, "result": {...}} or a failure.
  serve     argv: --fd N; stdin: the same spec as test plus "shm" (path of a
            frame buffer file) and "shm_size". Loads once, then answers
            ("infer", h, w, threshold) messages on the inherited socket with
            ("ok", result) / ("err", code, detail). Frames arrive through
            the shared buffer, results through the socket.

Failure codes are stable strings; the backend turns them into plain words
and a fix (app/models_custom/errors.py). `detail` is technical and goes
behind the "Details" disclosure.
"""
from __future__ import annotations

import ast
import json
import os
import sys
import time

# ONNX operator domains onnxruntime runs without extra code.
STANDARD_DOMAINS = {"", "ai.onnx", "ai.onnx.ml", "com.microsoft", "ai.onnx.preview.training"}
# Classes beyond which a [1, a, b] output is not a YOLO head we understand.
MAX_CLASSES = 5000
# A [1, N, D] output with N at or below this is a query-based (DETR style) or
# end-to-end (NMS inside) head; dense YOLO heads have thousands of anchors.
MAX_QUERIES = 1000
DEFAULT_SIZE = {"detect": 640, "classify": 224}
IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]
NMS_IOU = 0.45
MAX_DETECTIONS = 300
TOP_K = 5


class Fail(Exception):
    def __init__(self, code: str, detail: str = "", **extra):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail
        self.extra = extra


# ── File sniffing ─────────────────────────────────────────────────────────

def sniff(path: str) -> None:
    """Refuse well-known non-ONNX formats by their first bytes, whatever
    the file is called."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            head = f.read(64)
    except OSError as e:
        raise Fail("storage_failed", str(e))
    if size == 0:
        raise Fail("empty_file")
    if head.startswith(b"PK\x03\x04"):
        # PyTorch's default .pt / .pth is a zip with a pickle inside.
        import zipfile
        try:
            names = zipfile.ZipFile(path).namelist()
        except Exception:
            names = []
        if any(n.endswith("data.pkl") for n in names):
            raise Fail("pytorch_file")
        if any(n.endswith("saved_model.pb") for n in names):
            raise Fail("tensorflow_file")
        raise Fail("archive_file")
    if head[:1] == b"\x80" and head[1:2] in (b"\x02", b"\x03", b"\x04", b"\x05"):
        raise Fail("pickle_file")
    if head[4:8] == b"TFL3":
        raise Fail("tflite_file")
    if head.startswith(b"\x89HDF"):
        raise Fail("keras_file")
    if len(head) >= 9 and head[8:9] == b"{":
        n = int.from_bytes(head[:8], "little")
        if 0 < n < size:
            raise Fail("safetensors_file")


# ── Static checks with the onnx package (when installed) ──────────────────

def static_checks(path: str) -> dict:
    """Custom operator domains, missing external data, the opset. Done on the
    graph without running anything; skipped when `onnx` is not installed
    (onnxruntime's own load errors are then mapped instead)."""
    try:
        import onnx
        from onnx import external_data_helper
    except Exception:
        return {}
    try:
        model = onnx.load(path, load_external_data=False)
    except Exception as e:
        raise Fail("not_onnx", f"{type(e).__name__}: {e}")
    out: dict = {"ir_version": int(model.ir_version),
                 "producer": f"{model.producer_name} {model.producer_version}".strip()}
    opsets = {o.domain: int(o.version) for o in model.opset_import}
    out["opset"] = opsets.get("", opsets.get("ai.onnx"))
    domains = set()

    def walk(graph):
        for node in graph.node:
            if node.domain not in STANDARD_DOMAINS:
                domains.add(node.domain)
            for attr in node.attribute:
                if attr.g is not None and attr.g.node:
                    walk(attr.g)
                for g in attr.graphs:
                    walk(g)

    walk(model.graph)
    # A domain imported but never used is harmless; one used by a node is not.
    if domains:
        raise Fail("custom_ops", ", ".join(sorted(domains)), domains=sorted(domains))
    base = os.path.dirname(os.path.abspath(path))
    for tensor in external_data_helper._get_all_tensors(model):
        if not external_data_helper.uses_external_data(tensor):
            continue
        info = {e.key: e.value for e in tensor.external_data}
        loc = info.get("location", "")
        target = os.path.normpath(os.path.join(base, loc))
        if not loc or os.path.isabs(loc) or not target.startswith(base + os.sep) \
                or not os.path.isfile(target):
            raise Fail("external_data_missing", loc or "(no location)", file=loc)
    try:
        newest = int(onnx.defs.onnx_opset_version())
        if out["opset"] and out["opset"] > newest:
            raise Fail("opset_too_new", f"opset {out['opset']} > {newest}",
                       opset=out["opset"], max_opset=newest)
    except Fail:
        raise
    except Exception:
        pass
    return out


def classify_load_error(text: str) -> str:
    t = text.lower()
    if "unsupported model ir version" in t:
        return "ir_too_new"
    if "opset" in t and ("not supported" in t or "under development" in t or "unsupported" in t):
        return "opset_too_new"
    if "no op registered" in t or "is not a registered function/op" in t \
            or "unrecognized attribute" in t and "domain" in t:
        return "custom_ops"
    if "external" in t and ("data" in t or "initializer" in t):
        return "external_data_missing"
    if "protobuf parsing failed" in t or "invalid_protobuf" in t or "failed to load model" in t \
            and "parse" in t:
        return "not_onnx"
    if "out of memory" in t or "bad_alloc" in t or "failed to allocate" in t:
        return "out_of_memory"
    return "load_failed"


# ── Session ───────────────────────────────────────────────────────────────

def open_session(path: str, use_gpu: bool, *, threads: int = 2, gpu_mem_mb: int = 0):
    """(session, provider name, warnings). CUDA when asked for and usable,
    else CPU; never TensorRT here (its engine build takes minutes)."""
    import onnxruntime as ort
    warnings = []
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    opts.intra_op_num_threads = max(1, int(threads))
    opts.inter_op_num_threads = 1
    providers = []
    if use_gpu and "CUDAExecutionProvider" in ort.get_available_providers():
        # Without torch in this process the CUDA and cuDNN libraries of the
        # pip `nvidia-*` wheels are not on the loader path yet.
        try:
            ort.preload_dlls()
        except Exception:
            pass
        cuda = {"arena_extend_strategy": "kSameAsRequested"}
        if gpu_mem_mb and gpu_mem_mb > 0:
            cuda["gpu_mem_limit"] = int(gpu_mem_mb) * 1024 * 1024
        providers.append(("CUDAExecutionProvider", cuda))
    providers.append("CPUExecutionProvider")
    try:
        sess = ort.InferenceSession(path, sess_options=opts, providers=providers)
    except MemoryError as e:
        raise Fail("out_of_memory", str(e))
    except Exception as e:
        text = f"{type(e).__name__}: {e}"
        raise Fail(classify_load_error(text), text[:2000])
    active = sess.get_providers()
    provider = "cuda" if active and active[0] == "CUDAExecutionProvider" else "cpu"
    if use_gpu and provider == "cpu" and len(providers) > 1:
        warnings.append("The GPU was not usable for this model; it runs on the CPU.")
    return sess, provider, warnings


# ── Inspection ────────────────────────────────────────────────────────────

def _dim(d):
    """A static positive int, else None (dynamic: a name, None or -1)."""
    return d if isinstance(d, int) and d > 0 else None


def _parse_names(raw) -> list:
    """Ultralytics stores names as the repr of {0: 'person', ...}."""
    if not raw:
        return []
    try:
        val = ast.literal_eval(raw) if isinstance(raw, str) else raw
    except Exception:
        return []
    if isinstance(val, dict):
        try:
            return [str(val[k]) for k in sorted(val, key=lambda k: int(k))]
        except Exception:
            return [str(v) for v in val.values()]
    if isinstance(val, (list, tuple)):
        return [str(v) for v in val]
    return []


def _read_json(path):
    if not path:
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _hf_labels(config: dict) -> list:
    id2label = config.get("id2label") or {}
    if not isinstance(id2label, dict) or not id2label:
        return []
    try:
        return [str(id2label[k]) for k in sorted(id2label, key=lambda k: int(k))]
    except Exception:
        return []


def _image_input(sess) -> dict:
    inputs = sess.get_inputs()
    if not inputs:
        raise Fail("input_not_image", "the model declares no inputs")
    if len(inputs) > 1:
        names = [i.name for i in inputs]
        raise Fail("multiple_inputs", ", ".join(names), count=len(names), names=names)
    inp = inputs[0]
    shape = list(inp.shape or [])
    if len(shape) != 4:
        raise Fail("input_not_image", f"{inp.name}: shape {shape}", shape=[str(s) for s in shape])
    dtype = {"tensor(float)": "float32", "tensor(float16)": "float16",
             "tensor(uint8)": "uint8"}.get(inp.type)
    if dtype is None:
        raise Fail("input_dtype", inp.type, dtype=inp.type)
    batch = _dim(shape[0])
    if batch is not None and batch != 1:
        raise Fail("dynamic_input", f"batch size {batch}", reason="batch")
    if _dim(shape[1]) in (1, 3):
        layout, channels, h, w = "nchw", shape[1], _dim(shape[2]), _dim(shape[3])
    elif _dim(shape[3]) in (1, 3):
        layout, channels, h, w = "nhwc", shape[3], _dim(shape[1]), _dim(shape[2])
    elif _dim(shape[1]) is None:
        # A named channel axis (Hugging Face / PyTorch exports write
        # ["batch_size", "num_channels", "height", "width"]): NCHW, colour.
        layout, channels, h, w = "nchw", 3, _dim(shape[2]), _dim(shape[3])
    elif _dim(shape[3]) is None:
        layout, channels, h, w = "nhwc", 3, _dim(shape[1]), _dim(shape[2])
    else:
        raise Fail("dynamic_input", f"{inp.name}: shape {shape} has no 1 or 3 channel axis",
                   reason="channels", shape=[str(s) for s in shape])
    for v in (h, w):
        if v is not None and not (16 <= v <= 4096):
            raise Fail("input_size_unusual", f"{inp.name}: shape {shape}", size=v)
    return {"name": inp.name, "shape": [s if isinstance(s, int) else str(s) for s in shape],
            "dtype": dtype, "layout": layout, "channels": channels, "height": h, "width": w}


def _outputs(sess) -> list:
    return [{"name": o.name, "shape": [s if isinstance(s, int) else str(s) for s in (o.shape or [])],
             "type": o.type} for o in sess.get_outputs()]


def infer_head(outputs: list, n_labels: int, *, task_hint: str = "", arch: str = "") -> dict:
    """The task and how to decode the outputs, from their shapes.

    detect layouts:
      yolov8     one output [1, 4+C, N]: cx cy w h + C class scores (v8, v11)
      yolov8t    the same transposed, [1, N, 4+C]
      yolov5     [1, N, 5+C]: cx cy w h, objectness, C class scores
      e2e        [1, K, 6]: x1 y1 x2 y2 score class (NMS inside: v10, nms=True)
      rtdetr     [1, Q, 4+C] with Q <= 1000: cx cy w h (0-1) + C scores
      detr       two outputs, logits [1, Q, C(+1)] and boxes [1, Q, 4] (0-1)
    classify: one output [1, C] (or [1, C, 1, 1]).
    """
    shapes = [o["shape"] for o in outputs]
    want = task_hint if task_hint in ("detect", "classify") else ""

    def ints(shape):
        return [s if isinstance(s, int) and s > 0 else None for s in shape]

    # DETR style: one output ends in 4 (boxes), another is the logits.
    if len(outputs) >= 2 and want != "classify":
        by = {o["name"]: o for o in outputs}
        boxes = by.get("pred_boxes") or next(
            (o for o in outputs if len(o["shape"]) == 3 and ints(o["shape"])[2] == 4), None)
        logits = by.get("logits") or next(
            (o for o in outputs if o is not boxes and len(o["shape"]) == 3), None)
        if boxes is not None and logits is not None:
            k = ints(logits["shape"])[2]
            if k:
                softmax = bool(n_labels and k == n_labels + 1) or (
                    not n_labels and "detr" in arch.lower() and "rtdetr" not in arch.lower()
                    and "deformable" not in arch.lower())
                return {"task": "detect", "layout": "detr", "boxes_output": boxes["name"],
                        "logits_output": logits["name"],
                        "classes": k - 1 if softmax else k, "softmax": softmax,
                        "normalized": True}
        if any(len(s) == 4 for s in shapes[1:]):
            raise Fail("task_unsupported", f"outputs {shapes}", task="segment")
    first = outputs[0]
    s = ints(first["shape"])
    if want != "detect" and (len(s) == 2 or (len(s) == 4 and s[2] == 1 and s[3] == 1)):
        c = s[1]
        if c is None and n_labels:
            c = n_labels
        if c and c >= 2:
            return {"task": "classify", "layout": "classify", "output": first["name"], "classes": c}
    if want == "classify":
        raise Fail("unknown_layout", f"outputs {shapes}", expected="classify", shapes=shapes)
    if len(s) == 3:
        a, b = s[1], s[2]
        if a is not None and b is not None and a < b:
            if a < 5 or a - 4 > MAX_CLASSES:
                raise Fail("unknown_layout", f"outputs {shapes}", shapes=shapes)
            return {"task": "detect", "layout": "yolov8", "output": first["name"], "classes": a - 4}
        if a is not None and b is None:
            return {"task": "detect", "layout": "yolov8", "output": first["name"], "classes": a - 4}
        if b is not None and b >= 5:
            few = a is not None and a <= MAX_QUERIES
            if b in (6, 7) and few and not (n_labels and b in (n_labels + 4, n_labels + 5)):
                return {"task": "detect", "layout": "e2e", "output": first["name"],
                        "classes": n_labels or 0, "extra_column": b == 7}
            if n_labels and b == n_labels + 4:
                layout = "rtdetr" if few else "yolov8t"
                return {"task": "detect", "layout": layout, "output": first["name"],
                        "classes": n_labels, "normalized": layout == "rtdetr"}
            if n_labels and b == n_labels + 5:
                return {"task": "detect", "layout": "yolov5", "output": first["name"],
                        "classes": n_labels}
            if few:
                return {"task": "detect", "layout": "rtdetr", "output": first["name"],
                        "classes": b - 4, "normalized": True}
            if b - 5 >= 1:
                return {"task": "detect", "layout": "yolov5", "output": first["name"],
                        "classes": b - 5}
    if len(s) == 4 and want != "classify":
        raise Fail("task_unsupported", f"outputs {shapes}", task="segment")
    raise Fail("unknown_layout", f"outputs {shapes}", shapes=shapes)


def inspect(req: dict) -> dict:
    path = req["model"]
    sniff(path)
    static = static_checks(path)
    sess, provider, warnings = open_session(path, bool(req.get("use_gpu")),
                                            threads=int(req.get("threads") or 2))
    meta = sess.get_modelmeta()
    custom = dict(meta.custom_metadata_map or {})
    config = _read_json(req.get("config"))
    pre = _read_json(req.get("preprocessor"))
    inp = _image_input(sess)
    outputs = _outputs(sess)

    ultra_task = (custom.get("task") or "").strip().lower()
    is_ultra = bool(custom.get("names")) or "ultralytics" in (custom.get("author", "") +
                                                             custom.get("description", "")).lower()
    if ultra_task in ("segment", "pose", "obb"):
        raise Fail("task_unsupported", f"Ultralytics task {ultra_task}", task=ultra_task)
    labels, label_source = [], "none"
    if req.get("labels"):
        labels, label_source = [str(x) for x in req["labels"]], "file"
    elif _parse_names(custom.get("names")):
        labels, label_source = _parse_names(custom.get("names")), "ultralytics"
    elif _hf_labels(config):
        labels, label_source = _hf_labels(config), "huggingface"
    archs = config.get("architectures") or []
    arch = str(archs[0]) if archs else ""
    hint = req.get("task") or ""
    if not hint and ultra_task in ("detect", "classify"):
        hint = ultra_task
    if not hint and arch.endswith("ForImageClassification"):
        hint = "classify"
    if not hint and arch.endswith("ForObjectDetection"):
        hint = "detect"
    head = infer_head(outputs, len(labels), task_hint=hint, arch=arch)
    task = head["task"]

    # Input size: the declared one, else Ultralytics imgsz, else the
    # preprocessor's, else the task default.
    h, w = inp["height"], inp["width"]
    size_src = "model"
    if h is None or w is None:
        imgsz = []
        try:
            imgsz = [int(v) for v in ast.literal_eval(custom.get("imgsz", "[]"))]
        except Exception:
            imgsz = []
        psize = pre.get("size") if isinstance(pre.get("size"), dict) else {}
        if len(imgsz) == 2:
            h, w, size_src = h or imgsz[0], w or imgsz[1], "ultralytics"
        elif psize.get("height") and psize.get("width"):
            h, w, size_src = h or int(psize["height"]), w or int(psize["width"]), "preprocessor"
        elif psize.get("shortest_edge") and task == "classify":
            e = int(psize["shortest_edge"])
            h, w, size_src = h or e, w or e, "preprocessor"
        else:
            d = DEFAULT_SIZE[task]
            h, w, size_src = h or w or d, w or h or d, "default"
    # Pixel preparation.
    if pre:
        mean = pre.get("image_mean") if pre.get("do_normalize", True) else None
        std = pre.get("image_std") if pre.get("do_normalize", True) else None
        scale = float(pre.get("rescale_factor", 1 / 255)) if pre.get("do_rescale", True) else 1.0
        resize = "stretch"
    elif is_ultra:
        mean = std = None
        scale = 1 / 255
        resize = "letterbox" if head.get("layout") in ("yolov8", "yolov8t", "yolov5", "e2e") \
            else ("center_crop" if task == "classify" else "stretch")
    else:
        mean = IMAGENET_MEAN if task == "classify" or head.get("layout") == "detr" else None
        std = IMAGENET_STD if mean else None
        scale = 1 / 255
        resize = "letterbox" if head.get("layout") in ("yolov8", "yolov8t", "yolov5", "e2e") \
            else ("center_crop" if task == "classify" else "stretch")
    if inp["dtype"] == "uint8":
        mean = std = None
        scale = 1.0
    if not labels:
        labels = [f"class {i}" for i in range(head.get("classes") or 0)]
    elif head.get("classes") and len(labels) != head["classes"]:
        warnings.append(f"The model has {head['classes']} classes but {len(labels)} names; "
                        "check the class names.")
        if len(labels) < head["classes"]:
            labels = labels + [f"class {i}" for i in range(len(labels), head["classes"])]
    return {
        "task": task, "head": head, "input": inp, "outputs": outputs,
        "input_size": [int(h), int(w)], "input_size_source": size_src,
        "preprocess": {"resize": resize, "scale": scale, "mean": mean, "std": std,
                       "rgb": True},
        "labels": labels, "label_source": label_source,
        "metadata": {k: v[:500] for k, v in list(custom.items())[:30]},
        "architecture": arch, "provider": provider, "warnings": warnings,
        "opset": static.get("opset"), "ir_version": static.get("ir_version"),
        "producer": static.get("producer") or meta.producer_name or "",
    }


# ── Running ───────────────────────────────────────────────────────────────

class Model:
    """A loaded model plus its pre- and post-processing, from an inspect
    result (`spec`)."""

    def __init__(self, path: str, spec: dict, *, use_gpu: bool, threads: int = 2,
                 gpu_mem_mb: int = 0):
        import numpy as np
        self.np = np
        self.spec = spec
        self.sess, self.provider, self.warnings = open_session(
            path, use_gpu, threads=threads, gpu_mem_mb=gpu_mem_mb)
        self.inp = spec["input"]
        self.head = spec["head"]
        self.task = spec["task"]
        self.h, self.w = spec["input_size"]
        pre = spec["preprocess"]
        self.resize = pre["resize"]
        self.scale = float(pre.get("scale") or 1.0)
        self.mean = np.array(pre["mean"], dtype=np.float32) if pre.get("mean") else None
        self.std = np.array(pre["std"], dtype=np.float32) if pre.get("std") else None
        self.dtype = {"float32": np.float32, "float16": np.float16, "uint8": np.uint8}[self.inp["dtype"]]
        self.out_names = [o.name for o in self.sess.get_outputs()]

    # pre ------------------------------------------------------------------
    def preprocess(self, frame_bgr):
        import cv2
        np = self.np
        fh, fw = frame_bgr.shape[:2]
        geo = {"fw": fw, "fh": fh, "mode": self.resize}
        if self.resize == "letterbox":
            r = min(self.h / fh, self.w / fw)
            nh, nw = max(1, int(round(fh * r))), max(1, int(round(fw * r)))
            img = cv2.resize(frame_bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
            top, left = (self.h - nh) // 2, (self.w - nw) // 2
            canvas = np.full((self.h, self.w, 3), 114, dtype=np.uint8)
            canvas[top:top + nh, left:left + nw] = img
            img = canvas
            geo.update(r=r, top=top, left=left)
        elif self.resize == "center_crop":
            r = max(self.h / fh, self.w / fw)
            nh, nw = max(self.h, int(round(fh * r))), max(self.w, int(round(fw * r)))
            img = cv2.resize(frame_bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
            top, left = (nh - self.h) // 2, (nw - self.w) // 2
            img = img[top:top + self.h, left:left + self.w]
        else:
            img = cv2.resize(frame_bgr, (self.w, self.h), interpolation=cv2.INTER_LINEAR)
            geo.update(sx=fw / self.w, sy=fh / self.h)
        if self.inp["channels"] == 1:
            img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)[:, :, None]
        else:
            img = img[:, :, ::-1]                       # BGR -> RGB
        if self.dtype is np.uint8:
            x = np.ascontiguousarray(img)
        else:
            x = img.astype(np.float32) * self.scale
            if self.mean is not None and self.std is not None and self.inp["channels"] == 3:
                x = (x - self.mean) / self.std
        if self.inp["layout"] == "nchw":
            x = x.transpose(2, 0, 1)
        x = np.ascontiguousarray(x[None]).astype(self.dtype, copy=False)
        return x, geo

    # run ------------------------------------------------------------------
    def run(self, frame_bgr, threshold: float = 0.25) -> dict:
        np = self.np
        x, geo = self.preprocess(frame_bgr)
        try:
            outs = self.sess.run(None, {self.inp["name"]: x})
        except Exception as e:
            text = f"{type(e).__name__}: {e}"
            raise Fail("out_of_memory" if "memory" in text.lower() else "run_failed", text[:2000])
        named = dict(zip(self.out_names, outs))
        for v in named.values():
            if isinstance(v, np.ndarray) and v.dtype.kind == "f" and not np.isfinite(v).all():
                raise Fail("bad_output", "NaN or infinite values in the output")
        if self.task == "classify":
            return self._classify(named[self.head["output"]])
        return self._detect(named, geo, float(threshold))

    def _classify(self, out) -> dict:
        np = self.np
        v = np.asarray(out, dtype=np.float32).reshape(-1)
        if not (v.min() >= 0.0 and v.max() <= 1.0 and abs(float(v.sum()) - 1.0) < 0.02):
            e = np.exp(v - v.max())
            v = e / e.sum()
        idx = np.argsort(-v)[:TOP_K]
        return {"task": "classify", "top": [{"class_id": int(i), "score": float(v[i])} for i in idx]}

    def _detect(self, named, geo, thr) -> dict:
        np = self.np
        head = self.head
        layout = head["layout"]
        if layout == "detr":
            boxes = np.asarray(named[head["boxes_output"]], dtype=np.float32)[0]
            logits = np.asarray(named[head["logits_output"]], dtype=np.float32)[0]
            if head.get("softmax"):
                e = np.exp(logits - logits.max(axis=1, keepdims=True))
                probs = (e / e.sum(axis=1, keepdims=True))[:, :-1]
            else:
                probs = 1.0 / (1.0 + np.exp(-logits))
            cls = probs.argmax(axis=1)
            scores = probs[np.arange(len(cls)), cls]
            xyxy = _cxcywh_to_xyxy(np, boxes)
            return self._finish(xyxy, scores, cls, geo, thr, normalized=True, nms=False)
        out = np.asarray(named[head["output"]], dtype=np.float32)[0]
        if layout == "yolov8":
            out = out.T
        if layout in ("yolov8", "yolov8t", "rtdetr"):
            probs = out[:, 4:]
            if layout == "rtdetr" and (probs.min() < 0.0 or probs.max() > 1.0):
                probs = 1.0 / (1.0 + np.exp(-probs))
            cls = probs.argmax(axis=1)
            scores = probs[np.arange(len(cls)), cls]
            xyxy = _cxcywh_to_xyxy(np, out[:, :4])
            return self._finish(xyxy, scores, cls, geo, thr,
                                normalized=layout == "rtdetr", nms=layout != "rtdetr")
        if layout == "yolov5":
            probs = out[:, 5:] * out[:, 4:5]
            cls = probs.argmax(axis=1)
            scores = probs[np.arange(len(cls)), cls]
            xyxy = _cxcywh_to_xyxy(np, out[:, :4])
            return self._finish(xyxy, scores, cls, geo, thr, normalized=False, nms=True)
        if layout == "e2e":
            xyxy = out[:, :4]
            scores = out[:, 4]
            cls = out[:, 5].astype(np.int64)
            return self._finish(xyxy, scores, cls, geo, thr, normalized=False, nms=False)
        raise Fail("unknown_layout", layout)

    def _finish(self, xyxy, scores, cls, geo, thr, *, normalized: bool, nms: bool) -> dict:
        import cv2
        np = self.np
        keep = scores >= thr
        xyxy, scores, cls = xyxy[keep], scores[keep], cls[keep]
        if len(scores) > 3000:
            top = np.argsort(-scores)[:3000]
            xyxy, scores, cls = xyxy[top], scores[top], cls[top]
        if len(scores) and (normalized or float(np.abs(xyxy).max()) <= 1.5):
            xyxy = xyxy * np.array([self.w, self.h, self.w, self.h], dtype=np.float32)
        if nms and len(scores):
            wh = np.stack([xyxy[:, 0], xyxy[:, 1], xyxy[:, 2] - xyxy[:, 0],
                           xyxy[:, 3] - xyxy[:, 1]], axis=1)
            idx = cv2.dnn.NMSBoxesBatched(wh.tolist(), scores.tolist(), cls.astype(int).tolist(),
                                          thr, NMS_IOU)
            idx = np.array(idx, dtype=np.int64).reshape(-1)
            xyxy, scores, cls = xyxy[idx], scores[idx], cls[idx]
        order = np.argsort(-scores)[:MAX_DETECTIONS]
        fw, fh = geo["fw"], geo["fh"]
        dets = []
        for i in order:
            x1, y1, x2, y2 = (float(v) for v in xyxy[i])
            if geo["mode"] == "letterbox":
                r, left, top = geo["r"], geo["left"], geo["top"]
                x1, x2 = (x1 - left) / r, (x2 - left) / r
                y1, y2 = (y1 - top) / r, (y2 - top) / r
            else:
                x1, x2 = x1 * geo.get("sx", 1.0), x2 * geo.get("sx", 1.0)
                y1, y2 = y1 * geo.get("sy", 1.0), y2 * geo.get("sy", 1.0)
            x1, x2 = max(0, min(fw - 1, int(x1))), max(0, min(fw - 1, int(x2)))
            y1, y2 = max(0, min(fh - 1, int(y1))), max(0, min(fh - 1, int(y2)))
            if x2 <= x1 or y2 <= y1:
                continue
            dets.append({"class_id": int(cls[i]), "score": round(float(scores[i]), 4),
                         "box": [x1, y1, x2, y2]})
        return {"task": "detect", "detections": dets}


def _cxcywh_to_xyxy(np, b):
    cx, cy, w, h = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    return np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], axis=1)


def label_of(labels, class_id: int) -> str:
    return labels[class_id] if 0 <= class_id < len(labels) else f"class {class_id}"


def draw_preview(frame, result: dict, labels: list):
    import cv2
    img = frame.copy()
    if result.get("task") == "classify":
        y = 28
        for t in result.get("top", [])[:3]:
            text = f"{label_of(labels, t['class_id'])} {t['score'] * 100:.0f}%"
            cv2.putText(img, text, (12, y), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 4, cv2.LINE_AA)
            cv2.putText(img, text, (12, y), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2,
                        cv2.LINE_AA)
            y += 30
        return img
    for d in result.get("detections", []):
        x1, y1, x2, y2 = d["box"]
        cv2.rectangle(img, (x1, y1), (x2, y2), (80, 200, 255), 2)
        text = f"{label_of(labels, d['class_id'])} {d['score'] * 100:.0f}%"
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        ty = max(th + 4, y1)
        cv2.rectangle(img, (x1, ty - th - 4), (x1 + tw + 6, ty), (80, 200, 255), -1)
        cv2.putText(img, text, (x1 + 3, ty - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1,
                    cv2.LINE_AA)
    return img


def gpu_mem_mb():
    """This process's GPU memory from nvidia-smi, None when it cannot say."""
    import subprocess
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5)
    except Exception:
        return None
    if out.returncode != 0:
        return None
    for line in out.stdout.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) == 2 and parts[0] == str(os.getpid()):
            try:
                return int(parts[1])
            except ValueError:
                return None
    return None


def test(req: dict) -> dict:
    import cv2
    spec = req["spec"]
    model = Model(req["model"], spec, use_gpu=bool(req.get("use_gpu")),
                  threads=int(req.get("threads") or 2), gpu_mem_mb=int(req.get("gpu_mem_mb") or 0))
    labels = spec.get("labels") or []
    thr = float(req.get("threshold") or 0.25)
    frames = []
    for p in req.get("samples") or []:
        img = cv2.imread(p, cv2.IMREAD_COLOR)
        if img is not None:
            frames.append(img)
    if not frames:
        import numpy as np
        frames = [np.full((480, 640, 3), 127, dtype=np.uint8)]
    # Warm up (CUDA kernels, the arena), then time.
    for _ in range(2):
        model.run(frames[0], thr)
    times, per_sample, best = [], [], None
    for img in frames:
        for _ in range(3):
            t0 = time.perf_counter()
            res = model.run(img, thr)
            times.append((time.perf_counter() - t0) * 1000.0)
        n = len(res.get("detections", [])) if res["task"] == "detect" else len(res.get("top", []))
        per_sample.append({"found": n,
                           "top": [{"name": label_of(labels, t["class_id"]), "score": t["score"]}
                                   for t in res.get("top", [])[:3]]})
        if best is None or n > best[0]:
            best = (n, img, res)
    times.sort()
    latency = times[len(times) // 2]
    if req.get("preview") and best is not None:
        cv2.imwrite(req["preview"], draw_preview(best[1], best[2], labels),
                    [cv2.IMWRITE_JPEG_QUALITY, 85])
    return {"latency_ms": round(latency, 2), "fps": round(1000.0 / max(latency, 0.01), 1),
            "gpu_mem_mb": gpu_mem_mb() if model.provider == "cuda" else None,
            "provider": model.provider, "samples": per_sample, "warnings": model.warnings}


# ── Serve ─────────────────────────────────────────────────────────────────

def serve(req: dict, fd: int) -> None:
    import mmap
    import numpy as np
    from multiprocessing.connection import Connection
    conn = Connection(fd)
    try:
        model = Model(req["model"], req["spec"], use_gpu=bool(req.get("use_gpu")),
                      threads=int(req.get("threads") or 2),
                      gpu_mem_mb=int(req.get("gpu_mem_mb") or 0))
        with open(req["shm"], "r+b") as f:
            buf = mmap.mmap(f.fileno(), int(req["shm_size"]))
        warm = np.zeros((360, 640, 3), dtype=np.uint8)
        model.run(warm, 0.5)
    except Fail as e:
        conn.send(("fatal", e.code, e.detail))
        return
    except Exception as e:
        conn.send(("fatal", "load_failed", f"{type(e).__name__}: {e}"[:2000]))
        return
    conn.send(("ready", {"provider": model.provider, "warnings": model.warnings,
                         "gpu_mem_mb": gpu_mem_mb() if model.provider == "cuda" else None}))
    while True:
        try:
            msg = conn.recv()
        except (EOFError, OSError):
            return
        if not isinstance(msg, tuple) or not msg:
            continue
        if msg[0] == "bye":
            return
        if msg[0] == "ping":
            conn.send(("pong",))
            continue
        if msg[0] != "infer":
            continue
        _, h, w, c, thr = msg[:5]
        try:
            n = int(h) * int(w) * int(c)
            frame = np.frombuffer(buf, dtype=np.uint8, count=n).reshape(int(h), int(w), int(c))
            t0 = time.perf_counter()
            res = model.run(frame, float(thr))
            res["infer_ms"] = round((time.perf_counter() - t0) * 1000.0, 2)
            conn.send(("ok", res))
        except Fail as e:
            conn.send(("err", e.code, e.detail))
        except Exception as e:
            conn.send(("err", "run_failed", f"{type(e).__name__}: {e}"[:2000]))


def main(argv) -> int:
    mode = argv[1] if len(argv) > 1 else ""
    req = json.loads(sys.stdin.read() or "{}")
    if mode == "serve":
        fd = int(argv[argv.index("--fd") + 1])
        serve(req, fd)
        return 0
    try:
        if mode == "inspect":
            out = {"ok": True, "info": inspect(req)}
        elif mode == "test":
            out = {"ok": True, "result": test(req)}
        else:
            out = {"ok": False, "code": "load_failed", "detail": f"unknown mode {mode!r}"}
    except Fail as e:
        out = {"ok": False, "code": e.code, "detail": e.detail, "extra": e.extra}
    except MemoryError as e:
        out = {"ok": False, "code": "out_of_memory", "detail": str(e)}
    except Exception as e:
        out = {"ok": False, "code": "load_failed", "detail": f"{type(e).__name__}: {e}"[:2000]}
    sys.stdout.write("\n" + json.dumps(out, default=str) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
