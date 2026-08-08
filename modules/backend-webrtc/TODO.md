# backend-webrtc — TODO

## air_unit_srt (planned — docs/ROADMAP.md, ADR-002)

- [ ] Add `srt_video_source.py` modeled on `udp_video_source.py`. Keep the
      low-latency option block **verbatim**; extend `protocol_whitelist` with
      `srt`; input `srt://0.0.0.0:<port>?mode=listener&latency=<ms>`.
- [ ] Per-session SRT listener port allocation — reuse the port-scan approach in
      `events/swarm_events.py` rather than inventing a second scheme.
- [ ] Add `air_unit_srt` to the `server_sourced` tuple with its own branch.
      Keep the 5s no-frames guard — it matters *more* here, not less.
- [ ] Decide the port handshake: client offers → server allocates → returns
      `{srtHost, srtPort}` → client starts ffmpeg. **Open decision**, reorders
      the current "start bridge, then start stream" flow.
- [ ] Allow `client_overlay` for `air_unit_srt` — drop the
      `and not server_sourced` restriction for this mode once a local preview
      exists. Frees the entire downlink video leg (ADR-004).
- [ ] Verify `ffmpeg -protocols | grep srt` on the server; document the required
      inbound UDP port range.

## Tech debt

- [ ] `udp_video_source.py` binds `127.0.0.1`; `air_unit_udp` therefore only
      works co-located. Either document the limit in the source's docstring more
      prominently or make the bind address configurable.
- [ ] The low-latency ffmpeg option block is duplicated in
      `desktop/src/bridges/airUnitVideoBridge.ts`. De-duplicate or add a
      drift test.
- [ ] `signaling.py` branches on source string literals across four files'
      worth of coordinated edits. Consider a source registry if modes grow past
      five.
- [ ] Audit `sio.emit("error", ...)` sites here for whether the client is left
      in a non-terminal state (ADR-007 fixed the telemetry paths only).

## Scaling / unknowns

- [ ] **Needs verification:** concurrent-session capacity. One re-encode per
      spectator and GPU-bound inference are both unmeasured.
- [ ] No SFU / fan-out. Multiple viewers per drone each cost a re-encode.

## Nice to have

- [ ] Expose the negotiated codec and effective bitrate in `cv_results` or a
      stats event so the UI can show which path/quality is actually live —
      pairs with the planned auto-probe status line (ADR-003).
