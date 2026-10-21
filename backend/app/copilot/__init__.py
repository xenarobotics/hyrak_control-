"""
HYRAK Copilot: the pilot speaks (or types), the server turns it into one of
a fixed catalogue of skills, and every skill that moves the drone goes
through the same guards as the buttons. See docs/COPILOT.md.

  stt.py      speech to text (Whisper, lazy, fp16 on CUDA)
  vision.py   Florence-2: caption, phrase grounding, open detection
  planner.py  the local parser (offline, no key) and the Claude planner
  skills.py   the catalogue, argument checks, the motion guards
  survey.py   circle lawnmower waypoints from radius, altitude and camera
  service.py  per-session state, plan cards, tasks, the frame hook
  events.py   socket handlers (classified in app/auth/socket_classes.py)
"""
