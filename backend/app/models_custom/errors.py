"""
Every way adding or running a custom model can fail, in plain words with
the fix (docs/custom_models/DESIGN.md section 0, simplicity rule 4).

A failure is a stable `code` (what the runner, the Hugging Face client and
the routes report) plus a `message` (what happened, for someone who has
never trained a model) and a `hint` (what to do about it). Technical text
goes in `detail`, shown behind the UI's "Details" disclosure. The table is
the one place to read or change the wording; tests walk it.
"""
from __future__ import annotations

from dataclasses import dataclass, field

_EXPORT_YOLO = "yolo export model=best.pt format=onnx"
_EXPORT_HF = "optimum-cli export onnx --model <owner/repo> onnx_out/"

# code -> (message, hint). `{name}` fields come from the failure's extras.
KNOWN_FAILURES: dict[str, tuple[str, str]] = {
    # What was handed in is not an ONNX model.
    "pytorch_file": (
        "This file is a PyTorch model (.pt or .pth). HYRAK runs ONNX models, because a PyTorch "
        "file can run code when it is opened.",
        f"Export it to ONNX first, for example `{_EXPORT_YOLO}`, then upload the .onnx file."),
    "pickle_file": (
        "This file is a Python pickle (.pkl). HYRAK does not open pickles, because loading one "
        "can run code.",
        "Export the model to ONNX and upload the .onnx file."),
    "safetensors_file": (
        "This file holds only the weights (safetensors), not the network that uses them.",
        f"Export the whole model to ONNX, for example `{_EXPORT_HF}`."),
    "tensorflow_file": (
        "This is a TensorFlow model. HYRAK runs ONNX models.",
        "Convert it with `python -m tf2onnx.convert --saved-model <dir> --output model.onnx`."),
    "tflite_file": (
        "This is a TensorFlow Lite model. HYRAK runs ONNX models.",
        "Convert it with `python -m tf2onnx.convert --tflite model.tflite --output model.onnx`."),
    "keras_file": (
        "This is a Keras model (.h5). HYRAK runs ONNX models.",
        "Convert it to ONNX with tf2onnx, then upload the .onnx file."),
    "tensorrt_file": (
        "This is a TensorRT engine. Engines only work on the exact GPU they were built for.",
        f"Upload the ONNX file instead (for Ultralytics: `{_EXPORT_YOLO}`)."),
    "archive_file": (
        "This is a zip archive, not a model file.",
        "Unpack it and upload the .onnx file inside."),
    "wrong_extension": (
        "HYRAK accepts ONNX model files (.onnx) in this version.",
        f"Export your model to ONNX (for Ultralytics: `{_EXPORT_YOLO}`) and upload that file."),
    "not_onnx": (
        "This file is not a valid ONNX model. It may be damaged or only partly downloaded.",
        "Export the model to ONNX again and upload the new file."),
    "empty_file": (
        "The file is empty.",
        "Check the export finished, then upload the file again."),
    "too_large": (
        "The model is larger than the {limit_mb} MB limit.",
        "Use a smaller version of the model (for YOLO the n or s size), or export it in half "
        "precision (`half=True`)."),

    # Inputs and outputs HYRAK cannot feed or read.
    "multiple_inputs": (
        "The model expects {count} inputs ({names}); HYRAK models need one image input.",
        "Export it so the image is the only input (for Ultralytics leave out `nms=True`; for "
        "PaddleDetection models export without `im_shape` and `scale_factor`)."),
    "input_not_image": (
        "The model's input is not an image (HYRAK expects batch, channels, height and width).",
        "Use a vision model that takes one image. Text and audio models are not supported."),
    "input_dtype": (
        "The model's input is {dtype}; HYRAK feeds images as float32, float16 or uint8.",
        "Export the model with a standard image input (float32)."),
    "dynamic_input": (
        "The model's input shape is set up in a way HYRAK cannot feed ({reason}).",
        "Export with batch size 1 and 1 or 3 colour channels, for example "
        "`yolo export model=best.pt format=onnx imgsz=640 batch=1`."),
    "input_size_unusual": (
        "The model asks for images {size} pixels across, which is outside the 16 to 4096 range "
        "HYRAK supports.",
        "Export with a usual image size, for example `imgsz=640`."),
    "task_unsupported": (
        "This is a {task} model. This version runs models that find objects (boxes) or "
        "classify whole images.",
        "Use a detection or classification model. Segmentation and pose come in a later update."),
    "unknown_layout": (
        "HYRAK could not work out what this model outputs ({shapes}).",
        "HYRAK understands YOLO (v5, v8, v11 and end-to-end), RT-DETR and DETR detectors and "
        "image classifiers. If yours is one of these, set the task by hand under Details or ask "
        "HYRAK."),

    # The runtime cannot open it.
    "opset_too_new": (
        "The model was exported with a newer ONNX version (opset {opset}) than HYRAK can run.",
        "Export it again with an older opset, for example `opset=17`."),
    "ir_too_new": (
        "The model was saved by a newer ONNX exporter than HYRAK can read.",
        "Export it again with an older exporter or `opset=17`."),
    "custom_ops": (
        "The model uses custom operators ({domains}) that need extra code to run.",
        "Export it with standard ONNX operators only (turn off TensorRT plugins or custom NMS "
        "layers)."),
    "external_data_missing": (
        "The model keeps its weights in a separate file ({file}) that is missing.",
        "Upload a single .onnx file with the weights inside (models under 2 GB), or pick a "
        "Hugging Face repo where the .onnx_data file sits next to the .onnx file."),
    "load_failed": (
        "The model could not be opened by the ONNX runtime.",
        "Export it again with a recent exporter and `opset=17`. The details below say what "
        "went wrong."),
    "out_of_memory": (
        "The model needs more memory than this server allows for one model.",
        "Use a smaller version of the model, or export it in half precision."),

    # The test run.
    "run_failed": (
        "The model opened but failed while running on a test image.",
        "Check it was exported for images of the size it declares. The details below say what "
        "went wrong."),
    "bad_output": (
        "The model produced invalid numbers on a test image.",
        "Export it again in full precision (float32); half-precision exports sometimes "
        "overflow."),
    "timeout": (
        "Checking the model took too long (over {seconds} seconds).",
        "Try a smaller model. If it keeps happening, ask HYRAK."),
    "crashed": (
        "The checker stopped unexpectedly while opening the model.",
        "The file may be damaged. Export it again and upload the new file."),
    "storage_failed": (
        "The file could not be saved on the server.",
        "Try again in a minute. If it keeps happening, ask HYRAK."),

    # Hugging Face.
    "hf_bad_repo": (
        "That does not look like a Hugging Face model link.",
        "Paste `owner/model` or a link like https://huggingface.co/owner/model."),
    "hf_not_found": (
        "This Hugging Face repo was not found, or it is private.",
        "Check the name. Only public model repos can be added."),
    "hf_gated": (
        "This Hugging Face repo needs you to sign in and accept its terms.",
        "Only public repos without a sign-in can be added. Download the .onnx file yourself "
        "and upload it."),
    "hf_no_onnx": (
        "This Hugging Face repo has no .onnx file.",
        f"Pick a repo with an ONNX export (often in an `onnx/` folder), or export it yourself "
        f"with `{_EXPORT_HF}` and upload the file."),
    "hf_choose_file": (
        "This repo has several .onnx files.",
        "Choose the one to use."),
    "hf_file_not_found": (
        "The chosen file is not in this Hugging Face repo.",
        "Choose one of the .onnx files the repo lists."),
    "hf_unreachable": (
        "Hugging Face did not answer.",
        "Try again in a minute."),
    "hf_download_failed": (
        "The model could not be downloaded from Hugging Face.",
        "Try again in a minute. If it keeps happening, download the file and upload it."),

    # Access.
    "not_entitled": (
        "Adding your own models is a premium feature.",
        "Ask HYRAK to turn on Custom models for this workspace."),
    "quota": (
        "This workspace already has {limit} models, the most it can hold.",
        "Delete a model you no longer use, or ask HYRAK for a larger limit."),
    "busy": (
        "All of the server's custom model slots are in use.",
        "Try again in a minute, or stop a custom model on another drone."),
    "not_ready": (
        "This model is not ready to run yet.",
        "Wait for its check to finish, or fix what it reports."),
    "not_found": (
        "This model was not found.",
        "It may have been deleted. Pick another model."),
    "runner_failed": (
        "The model stopped working while it was running and could not be restarted.",
        "Select it again to retry. If it keeps happening, run the check again (Retest)."),
}


@dataclass(eq=False)
class ModelFailure(Exception):
    code: str
    detail: str = ""
    extra: dict = field(default_factory=dict)
    status: int = 400

    def __post_init__(self):
        super().__init__(self.code)

    @property
    def message(self) -> str:
        return describe(self.code, self.extra)[0]

    @property
    def hint(self) -> str:
        return describe(self.code, self.extra)[1]

    def public(self) -> dict:
        msg, hint = describe(self.code, self.extra)
        return {"code": self.code, "error": msg, "hint": hint, "detail": self.detail}


class _Blank(dict):
    def __missing__(self, key):
        return "?"


def describe(code: str, extra: dict | None = None) -> tuple[str, str]:
    """(message, hint) for a failure code; unknown codes read as a load failure."""
    msg, hint = KNOWN_FAILURES.get(code) or KNOWN_FAILURES["load_failed"]
    fields = _Blank()
    for k, v in (extra or {}).items():
        fields[k] = ", ".join(str(x) for x in v) if isinstance(v, (list, tuple)) else v
    try:
        return msg.format_map(fields), hint.format_map(fields)
    except Exception:
        return msg, hint


# Files refused by name before anything opens them: extension -> code.
REFUSED_EXTENSIONS = {
    ".pt": "pytorch_file", ".pth": "pytorch_file", ".ckpt": "pytorch_file",
    ".bin": "pytorch_file", ".pkl": "pickle_file", ".pickle": "pickle_file",
    ".joblib": "pickle_file", ".safetensors": "safetensors_file",
    ".tflite": "tflite_file", ".h5": "keras_file", ".keras": "keras_file",
    ".pb": "tensorflow_file", ".engine": "tensorrt_file", ".trt": "tensorrt_file",
    ".plan": "tensorrt_file", ".zip": "archive_file", ".tar": "archive_file",
    ".gz": "archive_file",
}


def check_filename(name: str) -> None:
    """Refuse anything but .onnx by its name, with the matching advice."""
    lower = (name or "").lower().strip()
    if lower.endswith(".onnx"):
        return
    for ext, code in REFUSED_EXTENSIONS.items():
        if lower.endswith(ext):
            raise ModelFailure(code, f"file name {name!r}")
    raise ModelFailure("wrong_extension", f"file name {name!r}")
