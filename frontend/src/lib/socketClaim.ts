// Correlates socket commands with their results on pages where more than
// one component listens to the same global events. The deliveries board
// (order flights) and the drones panel (return flights) both consume
// 'mission_upload_result' and 'action_result' from the singleton socket -
// without a claim, a RETURN TO STATION result could advance an order, and
// an order-start result could be eaten by the panel.
//
// Protocol: claim(name) right before emitting; every listener checks
// owner() === its name before consuming; release(name) when the flow ends.

let _owner: string | null = null

export function claimSocket(name: string): void {
    _owner = name
}

export function releaseSocket(name: string): void {
    if (_owner === name) _owner = null
}

export function socketOwner(): string | null {
    return _owner
}
