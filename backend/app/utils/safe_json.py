"""JSON for socket.io that browsers can always parse.

Python's json module serialises float('nan')/inf as literal NaN/Infinity,
which is NOT valid JSON. JavaScript's JSON.parse throws on it, and a
socket.io client that fails to parse ONE packet closes the whole
connection - the observable symptom is "telemetry connects, then the app
disconnects one second later", with nothing logged anywhere.

Passed to AsyncServer(json=...) so every emit is covered: any non-finite
float anywhere in any payload becomes null instead of poisoning the link.
"""
import json as _json
import math


def _sanitize(obj):
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v) for v in obj]
    return obj


def dumps(obj, *args, **kwargs):
    return _json.dumps(_sanitize(obj), *args, **kwargs)


loads = _json.loads
