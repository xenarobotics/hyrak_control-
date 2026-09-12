"""Obstacle avoidance capability.

Cross-cutting, not a vision mode: sensing is decoupled from deciding so the
same decision core runs on a monocular guess today and a fused ToF/LiDAR
picture tomorrow.

  observations - the sensor-agnostic obstacle bus + fusion (one representation
                 every sensor feeds; also emits the OBSTACLE_DISTANCE sector
                 array PX4's on-vehicle collision prevention consumes later)
  geometry     - project an observation (bearing/distance in the drone frame)
                 to a world keep-out using the drone's live pose
  reroute      - airspace-aware reroute around a keep-out, over the existing
                 planner (no legal way around -> the drone holds or returns)
  service      - per-drone state machine + the pure decide() the loop calls
  sensors      - declared sensor inventory + live "is it actually sending
                 data" verification
"""
