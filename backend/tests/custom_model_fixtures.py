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
