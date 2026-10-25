// Which USB serial devices are worth auto-connecting to, by USB vendor and
// product id - the same idea as QGroundControl's USBBoardInfo list.
//
//   fc   a flight controller on its own USB cable (MAVLink over USB CDC, so
//        the baud rate is ignored; 115200 is passed for form's sake)
//   sik  a SiK / 3DR / RFD telemetry radio (FTDI or SiLabs USB-UART at 57600)
//
// Anything else (an Arduino, a GPS puck, a USB-UART adapter for something
// unrelated) is never opened by auto-connect.

export type PortClass = 'fc' | 'sik' | 'other'

export interface PortInfoLike {
    path: string
    vendorId?: string
    productId?: string
    manufacturer?: string
    serialNumber?: string
    pnpId?: string
    friendlyName?: string
}

export interface Classified {
    cls: PortClass
    /** Baud to open with. Ignored by USB CDC, used by USB-UART radios. */
    baud: number
    /** Plain name for toasts: "Pixhawk / PX4 flight controller" */
    name: string
    /** A generic USB-UART chip that could just as well be something else.
     *  Probed a few times after plugging in, then left alone. */
    generic: boolean
}

// Flight controllers. Vendor-wide where the vendor makes nothing else that
// shows up as a serial port; product-specific otherwise.
const FC_VENDORS: Record<string, string> = {
    '26ac': 'Pixhawk / PX4 flight controller',   // 3D Robotics vendor id, used by PX4 FMU boards
    '2dae': 'CubePilot flight controller',        // Hex / CubePilot
    '3162': 'Holybro flight controller',          // Holybro (Pixhawk 4/5X/6X/6C)
    '35a7': 'ARK flight controller',
    '3185': 'flight controller',                  // Auterion era boards
    '1fc9': 'NXP flight controller',              // NXP FMUK66 / RDDRONE
    '27ac': 'Vertical Technologies flight controller',
}

// pid.codes (0x1209) and ST (0x0483) are shared by thousands of projects;
// only the product ids used by flight controllers count.
const FC_PRODUCTS: Record<string, string> = {
    '1209:5740': 'ArduPilot flight controller',
    '1209:5741': 'ArduPilot flight controller (bootloader)',
    '1209:db42': 'PX4 flight controller',
    '0483:5740': 'STM32 flight controller',       // ST VCP, used by many F4/F7/H7 boards
}

const SIK_PRODUCTS: Record<string, { name: string; generic: boolean }> = {
    '0403:6015': { name: 'SiK telemetry radio (FTDI)', generic: false },   // FT231X - 3DR / Holybro SiK
    '10c4:ea60': { name: 'SiK telemetry radio (CP210x)', generic: false }, // RFD900, many SiK clones
    '0403:6001': { name: 'telemetry radio (FTDI)', generic: true },        // FT232R - 3DR v1, also every FTDI cable
}

const norm = (s?: string) => (s ?? '').toLowerCase().replace(/^0x/, '').padStart(4, '0')

export function classifyPort(p: PortInfoLike): Classified {
    const vid = p.vendorId ? norm(p.vendorId) : ''
    const pid = p.productId ? norm(p.productId) : ''
    const key = `${vid}:${pid}`
    if (FC_PRODUCTS[key]) return { cls: 'fc', baud: 115200, name: FC_PRODUCTS[key], generic: false }
    if (vid && FC_VENDORS[vid]) return { cls: 'fc', baud: 115200, name: FC_VENDORS[vid], generic: false }
    const sik = SIK_PRODUCTS[key]
    if (sik) return { cls: 'sik', baud: 57600, name: sik.name, generic: sik.generic }
    return { cls: 'other', baud: 57600, name: p.manufacturer || 'serial device', generic: true }
}
