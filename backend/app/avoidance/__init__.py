"""Obstacle avoidance - the cloud companion's collision layer.

Data flow (current path, params.local_planner = 1):

    sensing/   camera frames or a depth sensor -> level, ground-rejected scans
    mapping/   each scan placed ONCE with the pose at capture -> occupancy grid
    core/      10 Hz supervisor: clear / avoid / hold / resume / return
    planning/  local planner -> Offboard velocity + heading setpoints

Layout:
    core/controller.py   AvoidanceController (per drone): params, state, decide_local
                         (current) and decide (legacy), registry, persisted on/off state
    core/loop.py         background task: pose feeds, goal selection, 10 Hz ticks
    core/executor.py     applies decisions to the aircraft (Offboard, HOLD, RTL, resume)
    sensing/camera.py    monocular: depth model -> ground-plane scale fit -> scan
    sensing/depth_scan.py      depth image -> ScanBins (shared by mono and true depth)
    sensing/mono_calibration.py  ground-plane scale fit for the mono depth model
    sensing/observations.py    single body-frame readings + the legacy sector bus
    sensing/registry.py        which sensors a drone has and whether they are live
    sensing/flat_segment.py    legacy mono detector, used only when no pose exists
    sensing/pointcloud.py      point cloud -> observations
    mapping/pose_history.py    timestamped pose per drone, interpolated at capture time
    mapping/occupancy.py       log-odds occupancy grid (current path)
    mapping/keepouts.py        keep-out circle map (legacy path)
    mapping/hazards.py         persistent known_obstacles table
    planning/local_planner.py  VFH + TTC local planner (current path)
    planning/reroute.py        mission-upload detour planner (legacy path)
    planning/geometry.py       body-frame -> world helpers
    events.py            avoidance_events table (Mission-tab timeline, review)
    routes.py            /api/avoidance HTTP API

Legacy path (params.local_planner = 0): keep-out map + mission-upload reroute,
kept selectable; see docs/avoidance/README.md for why it was replaced.
"""
