'use client'

import { useTheme } from '@/lib/theme'
import { Sun, Moon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS } from './flightStyles'
import { useHydrated } from '@/hooks/useClientValue'

export function ThemeToggle() {
    const { theme, setTheme } = useTheme()
    const mounted = useHydrated()

    // Render placeholder until mounted - prevents hydration mismatch
    if (!mounted) {
        return (
            <div className="w-12 h-10 rounded-lg" />
        )
    }

    const isDark = theme === 'dark'

    return (
        <button
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
            title={isDark ? 'Light mode' : 'Dark mode'}
            className={cn(
                'flex flex-col items-center gap-1 w-12 py-2 rounded-md transition-colors duration-[var(--dur-fast)]',
                'text-app-text-muted hover:text-app-text hover:bg-app-surface-2',
                FOCUS,
            )}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
            {isDark ? <Sun size={18} /> : <Moon size={18} />}
            <span className="text-[12px] font-semibold">{isDark ? 'Light' : 'Dark'}</span>
        </button>
    )
}