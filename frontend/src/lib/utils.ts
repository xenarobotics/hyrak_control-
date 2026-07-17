import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatAltitude(m: number): string {
  return `${m.toFixed(1)}m`
}

export function formatSpeed(ms: number): string {
  return `${ms.toFixed(1)}m/s`
}

export function formatHeading(deg: number): string {
  return `${Math.round(deg).toString().padStart(3, '0')}°`
}

export function formatBattery(pct: number): string {
  return `${Math.round(pct)}%`
}

export function batteryColor(pct: number): string {
  if (pct > 50) return 'text-green-400'
  if (pct > 20) return 'text-yellow-400'
  return 'text-red-400'
}

export function connectionColor(status: string): string {
  switch (status) {
    case 'connected': return 'bg-green-500'
    case 'connecting': return 'bg-yellow-500'
    case 'error': return 'bg-red-500'
    default: return 'bg-zinc-500'
  }
}