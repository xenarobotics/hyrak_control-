/**
 * A camera's display name. Some sources report the raw device id (a long
 * hex hash) or nothing as the label; show "Camera N" then. The value used
 * to select the camera is never changed, only what the user reads.
 */
export function cameraLabel(label: string | null | undefined, index: number): string {
    const l = (label ?? '').trim()
    if (!l || /^[0-9a-f]{16,}$/i.test(l) || /^[0-9a-f-]{32,}$/i.test(l)) return `Camera ${index + 1}`
    return l
}
