export interface DetectedObject {
    name: string
    count: number
}

export interface PersonData {
    id: number
    box: [number, number, number, number]
    conf: number
}

export interface Detection {
    name: string
    box: [number, number, number, number]
}

export interface CVResult {
    mode: string
    session_id: string
    analysis_time_ms: number
    timestamp: number
    // Server-measured throughput. Not derivable in the browser: in overlay
    // mode no video crosses the PeerConnection at all, so pc.getStats()
    // reports zeros and every client-side figure describes a transport the
    // video does not use.
    /** Frames per second the server actually forwarded downstream. */
    delivered_fps?: number
    /** Frames per second arriving from the source. A gap between this and
     *  delivered_fps is the pipeline shedding backlog to hold the live edge. */
    source_fps?: number
    /** Mean per-frame cost inside the server's recv() path, excluding the
     *  idle wait for a frame to arrive. */
    pipeline_ms?: number
    // Source frame size the box coordinates refer to (for canvas scaling)
    frame_w?: number
    frame_h?: number
    // Object detection
    objects?: Record<string, number>
    detections?: Detection[]
    person_count?: number
    total_count?: number
    // Human tracking
    persons?: PersonData[]
    selected_id?: number | null
    target_id?: number | null
    tracking?: boolean
    searching?: boolean
    face_confirmed?: boolean
    frames_lost?: number
    similarity?: number
    drone_command?: Record<string, number> | null
    // Depth mapping
    min_depth_m?: number
    max_depth_m?: number
    mean_depth_m?: number
    // Crowd management
    people?: { id: number; box: [number, number, number, number] }[]
    current_count?: number
    peak_count?: number
    distinct_tracks_seen?: number
    density_level?: 'green' | 'orange' | 'red'
    section_counts?: Record<number, number>
    section_grid?: [number, number]
    light_max?: number
    moderate_max?: number
    /** Rolling headcount samples (~2s apart, last 5 min). A live count alone
     *  cannot distinguish a steady crowd from one that doubled in a minute. */
    count_history?: { t: number; n: number }[]
    /** Rate of change over the last minute, people/min. */
    trend_per_min?: number | null
    /** Operator labels for the grid cells, keyed by cell index as a string. */
    zone_names?: Record<string, string>
    // Person tracking — face gallery.
    // `identities` is EVERY enrolled person recognised in frame, independent of
    // who holds the lock: identifying and following are separate jobs, and
    // naming only the followed person was a real bug.
    identities?: GalleryIdentity[]
    identified_count?: number
    /** Live enrolment in progress: shots captured so far. */
    capture?: { name: string; track_id: number; shots: number; needed: number } | null
    /** Result of a completed live enrolment. */
    enrolment_result?: { name: string; ok: number; total: number; errors: string[] }
    /** The followed person's name, when one is locked. */
    person_name?: string | null
    person_id?: string | null
    gallery_mode?: boolean
    gallery_margin?: number | null
    gallery_size?: number
    /** True when an operator picked the target rather than the tracker. */
    lock_manual?: boolean
    lock_hold_s?: number
    // Pursuit state — named rather than a single "tracking" flag, because
    // COASTING (still believes it knows where the target is) and SEARCHING
    // (guessing) need to be told apart.
    lock_state?: 'idle' | 'locked' | 'coasting' | 'searching' | 'lost'
    lock_message?: string
    seconds_lost?: number
    elevate?: {
        elevating: boolean
        climb_m_s: number
        blocked_by: string | null
        reason: string
    } | null
    // Vehicle / plate tracking. Plate/colour/type/speed are carried on the
    // vehicle itself (VehicleResult) rather than a separate plate list —
    // both vehicle-plate-tracking and traffic-management share this shape.
    plate_count?: number
    vehicles?: VehicleResult[]
    vehicles_in_frame?: number
    vehicle_count_unique?: number
    peak_vehicles?: number
    vehicle_types?: Record<string, number>
    vehicle_colors?: Record<string, number>
    // traffic-management
    plates_read?: number
    locked_track_id?: number | null
    /** vehicle-plate-tracking only: the locked vehicle's persistent id. */
    locked_vehicle_id?: string | null
    /** The locked vehicle's plate — the identity that survives a track id
     *  change, so it is what a re-acquisition can be checked against. */
    locked_plate?: string | null
    /** vehicle-plate-tracking follow: 'fixed' holds the altitude Offboard
     *  started at (nudge buttons still apply); 'auto' drives altitude to keep
     *  the vehicle vertically centred. Auto-elevate overrides both. */
    altitude_mode?: 'fixed' | 'auto'
    /** vehicle-plate-tracking follow: the "hold here" distance target, as
     *  target vehicle height / frame height. Adjustable via
     *  set_tracking_params — there is no fixed target that suits every
     *  vehicle, since apparent height depends on heading as much as range. */
    target_distance_ratio?: number
    /** What the locked vehicle is ACTUALLY filling right now, same units as
     *  target_distance_ratio. Shown together with the target because "the
     *  drone only moves backward" is indistinguishable from "the target is
     *  unreachable at this range" unless both numbers are visible at once. */
    vehicle_fill_pct?: number | null
    /** False when no telemetry is connected: speed needs metres, so it is
     *  omitted rather than guessed, and the overlay says so. */
    has_telemetry?: boolean
    alpr_available?: boolean
    faces_available?: boolean
    speed_is_estimate?: boolean
    /** Why speed is unavailable, when it is. A blank field is
     *  indistinguishable from a broken estimator. */
    speed_note?: string | null
    speed_available?: number
    person_count_unique?: number
    /** Slant range to frame centre — the distance a subject in the middle of
     *  frame actually sits at, which at a 45deg mount differs from altitude by
     *  a factor of 1.4. */
    slant_range_m?: number | null
    /** What this altitude can actually resolve, per subject. Without it a
     *  refused plate read is indistinguishable from a broken plate reader. */
    viability?: SubjectViability[]
    viable_subjects?: string[]
    viability_headline?: string
    /** traffic-management: what was ATTEMPTED this frame and why — the
     *  counterpart to `viability`, which says only what is resolvable.
     *  Without it a skipped plate read looks identical to a failed one. */
    profile?: CaptureProfile
    /** traffic-management: which kind of subject the lock is on. A person
     *  lock must not be described as a vehicle. */
    locked_kind?: 'vehicle' | 'person' | null
    /** What the locked subject is ACTUALLY filling, same units as
     *  target_distance_ratio. */
    subject_fill_pct?: number | null
    /** Why the altitude floor is holding, when it is. Silence here is what
     *  made a sustained descent impossible to see coming. */
    altitude_floor_reason?: string | null
}

/** Which analytics the current optics can support, and what that costs.
 *  Decided in pixels on target rather than altitude, so a sensor or lens
 *  change moves the usable ranges with no constant to update. */
export interface CaptureProfile {
    /** 'survey' = count/track/speed only; 'identify' adds plates;
     *  'forensic' adds face recognition. A label on the decision, never an
     *  input to it. */
    name: 'survey' | 'identify' | 'forensic'
    label: string
    /** fast-alpr calls allowed this frame. 0 when a plate cannot resolve at
     *  this range, and the reclaimed budget goes to whatever can. */
    ocr_calls: number
    faces: boolean
    headline: string
    subjects: ProfileSubject[]
}

export interface ProfileSubject {
    subject: 'plate' | 'face'
    attempt: boolean
    status: 'good' | 'marginal' | 'out_of_range' | 'unknown' | 'unavailable'
    px_on_target: number
    px_needed: number
    reason: string
    /** True when an operator forced this against the geometry. */
    forced: boolean
}

export interface SubjectViability {
    subject: 'vehicle' | 'person' | 'plate' | 'face'
    label: string
    px_on_target: number
    px_needed: number
    px_needed_marginal: number
    status: 'good' | 'marginal' | 'out_of_range' | 'unknown'
    /** Slant range at which this subject would be solidly readable. */
    max_range_m: number
    advice: string
}

export interface GalleryIdentity {
    track_id: number
    person_id: string
    name: string
    similarity: number
    best_similarity: number
    /** Independent frames agreeing on this name — the redundancy made visible. */
    votes: number
    /** Gap to the runner-up. Thin means the gallery cannot really separate two
     *  enrolled people on this frame, however high the top score looks. */
    margin: number | null
}

export interface VehicleResult {
    track_id: number | null
    /** This module's own persistent identity for the vehicle (e.g.
     *  "VH-000042"), distinct from track_id — a ByteTrack id resets on
     *  occlusion, this survives via a re-read plate. Only vehicle-plate-
     *  tracking sets this; traffic-management does not. */
    vehicle_id?: string | null
    box: [number, number, number, number]
    type: string
    color: string
    color_conf: number
    /** Ground-sample estimate, never a calibrated reading. */
    speed_kmh?: number | null
    speed_reliable?: boolean
    // traffic-management adds the plate onto the vehicle itself, since that
    // module reads plates from per-vehicle crops rather than the whole frame.
    plate?: string | null
    /** traffic-management only: a read that has not yet earned being reported.
     *  vehicle-plate-tracking reports every read via `plate` and expresses
     *  strength through plate_strong/plate_votes instead — suppressing weak
     *  reads there discarded nearly every genuine plate this rig captures. */
    plate_provisional?: string | null
    plate_conf?: number
    plate_votes?: number
    /** How many pixels across the plate actually was. The honest quality
     *  indicator: a 40px read and a 300px read are not equally trustworthy. */
    plate_px_w?: number
    /** Whether the text matches a known plate grammar. A flag, not a filter —
     *  real non-Indian plates (e.g. "719257C") do not match and are still
     *  perfectly valid readings. */
    plate_grammar_ok?: boolean
    /** Two or more independent FRAMES agreed on these characters. Drives how
     *  the reading is toned, never whether it is shown. */
    plate_strong?: boolean
    plate_box?: [number, number, number, number] | null
    /** The plate box as FRACTIONS of the vehicle box it was measured in.
     *  Preferred over plate_box for drawing: absolute coordinates are frozen
     *  at the moment of the read, and OCR only runs on a couple of vehicles
     *  per frame, so the bracket was left sitting where the plate had been
     *  seconds earlier while the vehicle moved on. */
    plate_box_rel?: [number, number, number, number] | null
    locked?: boolean
}