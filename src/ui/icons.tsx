// OurGlass icon set — lightweight stroke icons. Ported from the design system.
import type { SVGProps } from 'react'

type IcProps = { d: string | string[]; size?: number; sw?: number } & Omit<SVGProps<SVGSVGElement>, 'd'>

const Ic = ({ d, size = 18, sw = 1.6, fill = 'none', ...p }: IcProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill}
    stroke="currentColor"
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...p}
  >
    {Array.isArray(d) ? d.map((x, i) => <path key={i} d={x} />) : <path d={d} />}
  </svg>
)

type P = Partial<IcProps>

export const IconBolt = (p: P) => <Ic d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l0-8Z" fill="currentColor" stroke="none" {...p} />
export const IconShield = (p: P) => <Ic d={['M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z', 'm9 11.5 2 2 4-4.5']} {...p} />
export const IconRepeat = (p: P) => <Ic d={['M3 7h12a4 4 0 0 1 4 4', 'M16 4l3 3-3 3', 'M21 17H9a4 4 0 0 1-4-4', 'M8 20l-3-3 3-3']} {...p} />
export const IconLock = (p: P) => <Ic d={['M6 10V8a6 6 0 0 1 12 0v2', 'M5 10h14v10H5z', 'M12 14v3']} {...p} />
export const IconSign = (p: P) => <Ic d={['M3 19c3 .5 4-3 6-3s2 2 4 2 3-4 5-4', 'M14 5l3 3-8 8H6v-3l8-8Z']} {...p} />
export const IconCube = (p: P) => <Ic d={['M12 2 3 7v10l9 5 9-5V7l-9-5Z', 'M3 7l9 5 9-5', 'M12 12v10']} {...p} />
export const IconLink = (p: P) => <Ic d={['M9 15l6-6', 'M10 6l1-1a4 4 0 0 1 6 6l-1 1', 'M14 18l-1 1a4 4 0 0 1-6-6l1-1']} {...p} />
export const IconCopy = (p: P) => <Ic d={['M9 9h10v10H9z', 'M5 15V5h10']} {...p} />
export const IconCheck = (p: P) => <Ic d="M5 12.5 10 17l9-10" {...p} />
export const IconX = (p: P) => <Ic d={['M6 6l12 12', 'M18 6 6 18']} {...p} />
export const IconPlus = (p: P) => <Ic d={['M12 5v14', 'M5 12h14']} {...p} />
export const IconArrowR = (p: P) => <Ic d={['M5 12h14', 'M13 6l6 6-6 6']} {...p} />
export const IconArrowL = (p: P) => <Ic d={['M19 12H5', 'M11 6l-6 6 6 6']} {...p} />
export const IconClock = (p: P) => <Ic d={['M12 7v5l3 2', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z']} {...p} />
export const IconCal = (p: P) => <Ic d={['M4 6h16v15H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4']} {...p} />
export const IconWallet = (p: P) => <Ic d={['M3 7h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z', 'M3 7l0-2h13', 'M17 13h.01']} {...p} />
export const IconGrid = (p: P) => <Ic d={['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M13 13h7v7h-7z', 'M4 13h7v7H4z']} {...p} />
export const IconReceipt = (p: P) => <Ic d={['M5 3v18l2-1.3L9 21l2-1.3L13 21l2-1.3L17 21l2-1.3V3l-2 1.3L15 3l-2 1.3L11 3 9 4.3 7 3 5 4.3Z', 'M8 8h8', 'M8 12h8']} {...p} />
export const IconExt = (p: P) => <Ic d={['M14 4h6v6', 'M20 4l-9 9', 'M18 13v6H5V6h6']} {...p} />
export const IconChip = (p: P) => <Ic d={['M7 7h10v10H7z', 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3']} {...p} />
export const IconStop = (p: P) => <Ic d={['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M9 9h6v6H9z']} {...p} />
export const IconAlert = (p: P) => <Ic d={['M12 3 2 20h20L12 3Z', 'M12 10v4', 'M12 17h.01']} {...p} />
export const IconDoc = (p: P) => <Ic d={['M7 3h7l5 5v13H7z', 'M14 3v5h5', 'M10 13h6M10 17h6']} {...p} />
export const IconHash = (p: P) => <Ic d={['M5 9h14M5 15h14M10 4 8 20M16 4l-2 16']} {...p} />
export const IconGas = (p: P) => <Ic d={['M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16', 'M3 21h14', 'M6 9h8', 'M15 8l3 3v6a2 2 0 0 0 2-2v-6l-3-3']} {...p} />
export const IconUser = (p: P) => <Ic d={['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4 21a8 8 0 0 1 16 0']} {...p} />
