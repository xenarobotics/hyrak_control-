/**
 * Switching the active workspace (docs/ACCESS_MODEL.md section 8a).
 *
 * A customer's live session belongs to exactly one workspace, so a switch
 * ends it: whatever is running locally (the video stream, a radio relay) is
 * stopped first, then the socket reconnects with the new workspace_id.
 * Staff sessions are not scoped by the switcher (they stay on HYRAK), so
 * for staff a switch only changes the stored choice, as in phase 1.
 */
import { getUser, isCustomer } from './auth'
import { getActiveWorkspace, setActiveWorkspaceId } from './activeWorkspace'
import { reconnectSocket } from './socket'

type Teardown = () => void | Promise<void>

const teardowns = new Set<Teardown>()

/** Register something to stop before a customer's session changes workspace. */
export function onWorkspaceSwitch(fn: Teardown): () => void {
    teardowns.add(fn)
    return () => { teardowns.delete(fn) }
}

// A relay that never finishes closing must not hold the switch forever.
const TEARDOWN_TIMEOUT_MS = 4000

export async function switchActiveWorkspace(id: string): Promise<void> {
    if (id === getActiveWorkspace()?.id) return
    if (!isCustomer(getUser())) {
        setActiveWorkspaceId(id)
        return
    }
    const all = Promise.allSettled([...teardowns].map(fn => Promise.resolve().then(fn)))
    await Promise.race([all, new Promise(r => setTimeout(r, TEARDOWN_TIMEOUT_MS))])
    setActiveWorkspaceId(id)
    reconnectSocket()
}
