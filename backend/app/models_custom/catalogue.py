"""
The built-in AI modes as library cards, so the AI tab renders HYRAK
models, the HYRAK catalogue and a workspace's own models as one list
(docs/custom_models/DESIGN.md section 0, rule 1).

Only modes with an analyzer are listed (manual control is "no model", and
the placeholders without a module are left out; a test keeps this table
inside the analyzer registry). `icon` is a lucide icon
name the frontend maps; `staff_only` marks modes refused for customer
sessions (socket_classes.CUSTOMER_BLOCKED_MODES).
"""
from __future__ import annotations

from app.auth import socket_classes

# mode -> (name, one-line description, icon, task)
BUILTIN: dict[str, tuple[str, str, str, str]] = {
    "object-detection": ("Objects", "Finds everyday objects (people, cars, bikes and 77 more) "
                         "and draws boxes around them.", "scan-search", "detect"),
    "human-tracking": ("Follow person", "Finds people and can follow the one you pick.",
                       "users", "track"),
    "person-tracking": ("Person ID", "Recognises specific people you have added and tracks them.",
                        "scan-face", "track"),
    "crowd-management": ("Crowd", "Counts people, shows how dense each area is and warns when "
                         "it gets too crowded.", "users-round", "count"),
    "vehicle-plate-tracking": ("Plates", "Finds vehicles and reads their number plates.",
                               "scan-line", "detect"),
    "traffic-management": ("Traffic", "Counts vehicles and reads their type, colour, plate and "
                           "speed.", "traffic-cone", "detect"),
    "depth-mapping": ("Depth", "Shows how far away everything in the picture is.",
                      "layers", "depth"),
    "enhance": ("Enhance", "Makes the picture clearer: less noise, sharper, better colour.",
                "sparkles", "enhance"),
    "3d-reconstruction": ("3D Scan", "Builds a 3D model of the area as you fly.", "box", "3d"),
}
ORDER = ("object-detection", "human-tracking", "person-tracking", "crowd-management",
         "vehicle-plate-tracking", "traffic-management", "depth-mapping", "enhance",
         "3d-reconstruction")


def builtin_entries(*, staff: bool) -> list[dict]:
    out = []
    for mode in ORDER:
        staff_only = mode in socket_classes.CUSTOMER_BLOCKED_MODES
        if staff_only and not staff:
            continue
        name, desc, icon, task = BUILTIN[mode]
        out.append({
            "id": mode, "kind": "builtin", "mode": mode, "run_mode": mode, "name": name,
            "description": desc, "icon": icon, "task": task, "status": "ready",
            "runnable": True, "staff_only": staff_only,
        })
    return out
