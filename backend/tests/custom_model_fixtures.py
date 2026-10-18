"""
Tiny ONNX models for the custom model tests, built with onnx.helper.

Each model takes an image input and returns CONSTANT outputs (plus zero
times the input's mean, so the graph really reads its input): the decode
path is then tested against boxes we placed ourselves. A few kilobytes
each, written into the test's tmp_path, nothing checked in.
"""
from __future__ import annotations

import numpy as np
import pytest

onnx = pytest.importorskip("onnx")
from onnx import TensorProto, helper, numpy_helper  # noqa: E402


def make_model(path, outputs: dict, *, input_shape=(1, 3, 64, 64), input_type=TensorProto.FLOAT,
               metadata: dict | None = None, opset: int = 13, extra_inputs: int = 0,
               custom_domain: str | None = None, external_weights: bool = False,
               ir_version: int = 8):
    """`outputs`: name -> numpy array (the constant each output returns)."""
    nodes, inits = [], []
    inputs = [helper.make_tensor_value_info("images", input_type, list(input_shape))]
    for i in range(extra_inputs):
        inputs.append(helper.make_tensor_value_info(f"extra{i}", TensorProto.FLOAT, [1, 2]))
    src = "images"
    if input_type != TensorProto.FLOAT:
        nodes.append(helper.make_node("Cast", ["images"], ["images_f"], to=TensorProto.FLOAT))
        src = "images_f"
    nodes.append(helper.make_node("ReduceMean", [src], ["mean"],
                                  axes=list(range(len(input_shape))), keepdims=0))
    inits.append(numpy_helper.from_array(np.zeros((1,), np.float32), "zero"))
    nodes.append(helper.make_node("Mul", ["mean", "zero"], ["nothing"]))
    if custom_domain:
        nodes.append(helper.make_node("MagicOp", ["nothing"], ["nothing2"], domain=custom_domain))
        tail = "nothing2"
    else:
        tail = "nothing"
    outs = []
    for name, arr in outputs.items():
        arr = np.asarray(arr, dtype=np.float32)
        inits.append(numpy_helper.from_array(arr, f"{name}_const"))
        nodes.append(helper.make_node("Add", [f"{name}_const", tail], [name]))
        outs.append(helper.make_tensor_value_info(name, TensorProto.FLOAT, list(arr.shape)))
    graph = helper.make_graph(nodes, "tiny", inputs, outs, initializer=inits)
    imports = [helper.make_opsetid("", opset)]
    if custom_domain:
        imports.append(helper.make_opsetid(custom_domain, 1))
    model = helper.make_model(graph, opset_imports=imports, producer_name="hyrak-tests")
    model.ir_version = ir_version
    for k, v in (metadata or {}).items():
        model.metadata_props.append(onnx.StringStringEntryProto(key=k, value=v))
    if external_weights:
        onnx.save_model(model, str(path), save_as_external_data=True, all_tensors_to_one_file=True,
                        location="weights.bin", size_threshold=0)
    else:
        onnx.save_model(model, str(path))
    return path


def yolov8_output(n_classes=3, anchors=50, boxes=((32, 32, 20, 20, 1, 0.9),), size=64):
    """[1, 4+C, N]: each box (cx, cy, w, h, class, score) in input pixels."""
    out = np.zeros((1, 4 + n_classes, anchors), np.float32)
    for i, (cx, cy, w, h, c, s) in enumerate(boxes):
        out[0, :4, i] = [cx, cy, w, h]
        out[0, 4 + c, i] = s
    return out


def yolov5_output(n_classes=3, anchors=1200, boxes=((32, 32, 20, 20, 2, 0.9),)):
    out = np.zeros((1, anchors, 5 + n_classes), np.float32)
    for i, (cx, cy, w, h, c, s) in enumerate(boxes):
        out[0, i, :5] = [cx, cy, w, h, 1.0]
        out[0, i, 5 + c] = s
    return out


def e2e_output(boxes=((10, 10, 30, 30, 0.8, 1),), k=300):
    out = np.zeros((1, k, 6), np.float32)
    for i, b in enumerate(boxes):
        out[0, i] = b
    return out


def classify_output(scores=(0.1, 0.7, 0.2)):
    return np.asarray([scores], np.float32)


NAMES3 = "{0: 'person', 1: 'crack', 2: 'car'}"


def ultra_meta(task="detect", names=NAMES3, imgsz="[64, 64]"):
    return {"author": "Ultralytics", "task": task, "names": names, "imgsz": imgsz,
            "description": "Ultralytics YOLOv8n model"}


NAMES_SPOT = "{0: 'spot', 1: 'other'}"


def make_spot_model(path, *, batch="batch", size=64, patch=8):
    """A detector that really looks: its one anchor is a `patch` px box at
    the centre of the input, scored by how bright the input's centre patch
    is (mean of the scaled pixels, 1.0 for white). A small white square far
    from the frame's centre is only found once a tile puts it in the middle.
    Output [B, 4+2, 8] (yolov8 layout, classes spot and other); `batch`
    "batch" makes the batch axis dynamic, 1 fixes it."""
    lo, hi = size // 2 - patch // 2, size // 2 + patch // 2
    inits = [
        numpy_helper.from_array(np.array([lo, lo], np.int64), "starts"),
        numpy_helper.from_array(np.array([hi, hi], np.int64), "ends"),
        numpy_helper.from_array(np.array([2, 3], np.int64), "axes"),
        numpy_helper.from_array(np.array([-1, 1, 1], np.int64), "shape3"),
    ]
    const = np.zeros((1, 6, 8), np.float32)
    const[0, :4, 0] = [size / 2, size / 2, patch, patch]
    mask = np.zeros((1, 6, 8), np.float32)
    mask[0, 4, 0] = 1.0
    inits += [numpy_helper.from_array(const, "box_const"), numpy_helper.from_array(mask, "score_mask")]
    nodes = [
        helper.make_node("Slice", ["images", "starts", "ends", "axes"], ["centre"]),
        helper.make_node("ReduceMean", ["centre"], ["bright"], axes=[1, 2, 3], keepdims=1),
        helper.make_node("Reshape", ["bright", "shape3"], ["bright3"]),
        helper.make_node("Mul", ["bright3", "score_mask"], ["scores"]),
        helper.make_node("Add", ["box_const", "scores"], ["output0"]),
    ]
    graph = helper.make_graph(
        nodes, "spot",
        [helper.make_tensor_value_info("images", TensorProto.FLOAT, [batch, 3, size, size])],
        [helper.make_tensor_value_info("output0", TensorProto.FLOAT, [batch, 6, 8])],
        initializer=inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)],
                              producer_name="hyrak-tests")
    model.ir_version = 8
    for k, v in ultra_meta(names=NAMES_SPOT, imgsz=f"[{size}, {size}]").items():
        model.metadata_props.append(onnx.StringStringEntryProto(key=k, value=v))
    onnx.save_model(model, str(path))
    return path


def spot_frame(w=256, h=256, at=(71, 71), side=16):
    """A black frame with one white `side` px square centred at `at`."""
    f = np.zeros((h, w, 3), np.uint8)
    x, y = at
    f[y - side // 2:y + side // 2, x - side // 2:x + side // 2] = 255
    return f
