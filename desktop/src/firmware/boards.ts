// Bootloader board id -> PX4 build target, and where official builds live.
//
// The ids come from each board's firmware.prototype in PX4-Autopilot v1.17.0
// (boards/<vendor>/<model>/firmware.prototype, "board_id"). Only flight
// controllers are listed: CAN nodes, GPS units and IO coprocessors share ids
// with real flight controllers (cuav_can-gps-v1 is board 11, like the
// Pixracer) and must never be offered.
//
// Several boards share one id (1013 is four Matek-family boards). Then the
// operator picks; the downloaded file's board_id is checked against the
// bootloader before anything is erased, so a wrong pick is refused rather
// than flashed.
//
// Official builds: QGroundControl's own source, the PX4 build server bucket
//   https://px4-travis.s3.amazonaws.com/Firmware/{stable,beta,master}/<target>_default.px4

export interface BoardTarget {
    target: string
    name: string
}

const T = (target: string, name: string): BoardTarget => ({ target, name })

export const BOARD_TARGETS: Record<number, BoardTarget[]> = {
    9: [T('px4_fmu-v3', 'Pixhawk 1 / 2 (FMUv3, 2 MB flash)'), T('px4_fmu-v2', 'Pixhawk 1 (FMUv2, 1 MB flash)')],
    11: [T('px4_fmu-v4', 'Pixracer (FMUv4)')],
    12: [T('bitcraze_crazyflie', 'Crazyflie 2.0')],
    13: [T('px4_fmu-v4pro', 'Pixhawk 3 Pro (FMUv4 Pro)')],
    14: [T('bitcraze_crazyflie21', 'Crazyflie 2.1')],
    20: [T('uvify_core', 'UVify Core')],
    28: [T('nxp_fmuk66-v3', 'NXP FMUK66 v3')],
    30: [T('nxp_fmuk66-e', 'NXP FMUK66-E')],
    33: [T('mro_x21', 'mRo X2.1')],
    35: [T('px4_fmu-v6xrt', 'Pixhawk FMUv6X-RT')],
    36: [T('nxp_tropic-community', 'NXP Tropic Community')],
    37: [T('nxp_mr-tropic', 'NXP MR-Tropic')],
    42: [T('omnibus_f4sd', 'Omnibus F4 SD'), T('diatone_mamba-f405-mk2', 'Diatone Mamba F405 Mk2'), T('flywoo_gn-f405', 'Flywoo GN-F405')],
    50: [T('px4_fmu-v5', 'Pixhawk 4 (FMUv5)'), T('av_x-v1', 'AV-X v1')],
    51: [T('px4_fmu-v5x', 'Pixhawk 5X (FMUv5X)')],
    53: [T('px4_fmu-v6x', 'Pixhawk 6X (FMUv6X)'), T('auterion_fmu-v6x', 'Auterion FMUv6X')],
    54: [T('px4_fmu-v6u', 'Pixhawk FMUv6U')],
    55: [T('sky-drones_smartap-airlink', 'Sky-Drones SmartAP AIRLink')],
    56: [T('px4_fmu-v6c', 'Pixhawk 6C (FMUv6C)')],
    57: [T('ark_fmu-v6x', 'ARK FMUv6X')],
    58: [T('ark_pi6x', 'ARK Pi6X')],
    59: [T('ark_fpv', 'ARK FPV')],
    60: [T('auterion_fmu-v6s', 'Auterion FMUv6S')],
    78: [T('holybro_pix32v5', 'Holybro Pix32 v5')],
    88: [T('airmind_mindpx-v2', 'AirMind MindPX v2')],
    97: [T('atl_mantis-edu', 'ATL Mantis EDU')],
    120: [T('cubepilot_cubeyellow', 'Cube Yellow')],
    123: [T('holybro_kakutef7', 'Holybro Kakute F7')],
    136: [T('mro_x21-777', 'mRo X2.1-777')],
    139: [T('holybro_durandal-v1', 'Holybro Durandal'), T('spracing_h7extreme', 'SP Racing H7 Extreme')],
    140: [T('cubepilot_cubeorange', 'Cube Orange')],
    141: [T('mro_ctrl-zero-f7', 'mRo Control Zero F7'), T('mro_ctrl-zero-f7-oem', 'mRo Control Zero F7 OEM')],
    212: [T('thepeach_k1', 'ThePeach K1')],
    213: [T('thepeach_r1', 'ThePeach R1')],
    319: [T('xc-fly_xc-slim', 'XC-Fly XC-Slim'), T('xc-fly_xc-slam', 'XC-Fly XC-Slam')],
    1009: [T('cuav_nora', 'CUAV Nora')],
    1010: [T('cuav_x7pro', 'CUAV X7 Pro')],
    1013: [T('matek_h743', 'Matek H743'), T('matek_h743-slim', 'Matek H743-Slim'), T('matek_h743-mini', 'Matek H743-Mini'), T('hkust_nxt-v1', 'HKUST NxtPX4 v1'), T('hkust_nxt-dual', 'HKUST NxtPX4 Dual')],
    1017: [T('mro_pixracerpro', 'mRo Pixracer Pro')],
    1022: [T('mro_ctrl-zero-classic', 'mRo Control Zero Classic')],
    1023: [T('mro_ctrl-zero-h7', 'mRo Control Zero H7')],
    1024: [T('mro_ctrl-zero-h7-oem', 'mRo Control Zero H7 OEM')],
    1048: [T('holybro_kakuteh7', 'Holybro Kakute H7')],
    1053: [T('holybro_kakuteh7v2', 'Holybro Kakute H7 v2')],
    1058: [T('holybro_kakuteh7mini', 'Holybro Kakute H7 Mini')],
    1063: [T('cubepilot_cubeorangeplus', 'Cube Orange+')],
    1105: [T('holybro_kakuteh7-wing', 'Holybro Kakute H7 Wing')],
    1123: [T('siyi_n7', 'SIYI N7')],
    1124: [T('3dr_ctrl-zero-h7-oem-revg', '3DR Control Zero H7 OEM rev G')],
    1166: [T('micoair_h743', 'MicoAir H743')],
    1176: [T('micoair_h743-aio', 'MicoAir H743 AIO')],
    1179: [T('micoair_h743-v2', 'MicoAir H743 v2')],
    1183: [T('narinfc_h7', 'NarinFC H7')],
    1188: [T('corvon_743v1', 'Corvon 743 v1')],
    1200: [T('x-mav_ap-h743v2', 'X-MAV AP-H743 v2')],
    1410: [T('radiolink_PIX6', 'Radiolink PIX6')],
    5409: [T('holybro_kakuteh7dualimu', 'Holybro Kakute H7 Dual IMU')],
    7000: [T('cuav_7-nano', 'CUAV 7-Nano')],
    7001: [T('cuav_fmu-v6x', 'CUAV Pixhawk V6X')],
    7002: [T('cuav_x25-evo', 'CUAV X25 EVO')],
    7120: [T('accton-godwit_ga1', 'Accton Godwit GA1')],
    41775: [T('modalai_fc-v1', 'ModalAI Flight Core v1')],
    41776: [T('modalai_fc-v2', 'ModalAI Flight Core v2')],
}

export type FirmwareChannel = 'stable' | 'beta' | 'master'

export const CHANNEL_LABEL: Record<FirmwareChannel, string> = {
    stable: 'PX4 stable release',
    beta: 'PX4 beta (release candidate)',
    master: 'PX4 daily build (master)',
}

/** Targets that fit this board. Board 9 is the one id where flash size
 *  decides: FMUv2 has 1 MB usable, FMUv3 2 MB (QGC applies the same rule). */
export function targetsForBoard(boardId: number, flashSize: number): BoardTarget[] {
    const list = BOARD_TARGETS[boardId] ?? []
    if (boardId === 9) {
        const v3 = flashSize > 1032192
        return list.filter(t => (t.target === 'px4_fmu-v3') === v3)
    }
    return list
}

export function firmwareUrl(channel: FirmwareChannel, target: string): string {
    if (!/^[A-Za-z0-9_.-]+$/.test(target)) throw new Error('bad target name')
    return `https://px4-travis.s3.amazonaws.com/Firmware/${channel}/${target}_default.px4`
}
