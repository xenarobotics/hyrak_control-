"""
FC-level backstop: upload every red zone to the flight controller as a PX4
exclusion geofence (MAVLink fence mission via the MAVSDK Geofence plugin).
The server monitor is the fast supervisory layer, but it rides the cloud
link - this fence still holds if that link dies mid-flight. PX4's reaction
on breach is governed by its GF_ACTION parameter (default: Hold).
Best-effort by design: a failed upload logs a warning, never blocks flight.
"""
import logging

from app.zones import engine

logger = logging.getLogger("verocore.zones.fence")

# PX4 accepts a bounded number of geofence vertices; past it the whole upload
# is rejected (TOO_MANY_GEOFENCE_ITEMS) and the aircraft flies with NO FC
# backstop. Keep the combined red-zone vertex count under this - conservative
# headroom below PX4's typical ~100-point ceiling.
MAX_FENCE_VERTICES = 90


async def upload_red_fence(tel) -> bool:
    drone = getattr(tel, "_drone", None)
    if drone is None:
        return False
    rings = engine.red_polygon_rings(max_total_vertices=MAX_FENCE_VERTICES)
    if not rings:
        return False
    try:
        from mavsdk.geofence import FenceType, GeofenceData, Point, Polygon

        polygons = [
            Polygon([Point(lat, lng) for lat, lng in ring], FenceType.EXCLUSION)
            for ring in rings
        ]
        try:
            await drone.geofence.upload_geofence(GeofenceData(polygons=polygons, circles=[]))
        except TypeError:
            # older MAVSDK signature: upload_geofence(polygons)
            await drone.geofence.upload_geofence(polygons)
        logger.info(f"PX4 exclusion fence uploaded: {len(polygons)} red zone(s)")
        return True
    except Exception as e:
        logger.warning(f"Geofence upload failed (server enforcement still active): {e}")
        return False
