'use client'

import { useTheme } from '@/lib/theme'
import { useState, useEffect } from 'react'
import { Sun, Moon } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ThemeToggle() {
    const { theme, setTheme } = useTheme()
    const [mounted, setMounted] = useState(false)

    useEffect(() => { setMounted(true) }, [])

    // Render placeholder until mounted — prevents hydration mismatch
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
                'flex flex-col items-center gap-1 w-12 py-2 rounded-lg text-xs transition-colors',
                'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300',
                'hover:bg-zinc-100 dark:hover:bg-zinc-800'
            )}
        >
            {isDark ? <Sun size={18} /> : <Moon size={18} />}
            <span className="text-[10px] font-mono">{isDark ? 'Light' : 'Dark'}</span>
        </button>
    )
}