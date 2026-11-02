'use client'

import { createContext, useContext, useState } from 'react'
import { useClientValue } from '@/hooks/useClientValue'

// 'hyrak' is the default: the website's palette (graphite, silver, electric
// orange). 'dark' is the original teal palette. 'midnight' is the reworked
// high-contrast dark. 'hyrak' and 'midnight' stack the .dark class, so the
// shadcn variables and every `dark:` utility follow them and only the app
// tokens change. 'light' is the bright theme.
export type Theme = 'hyrak' | 'dark' | 'midnight' | 'light'
export const DEFAULT_THEME: Theme = 'hyrak'
const THEMES: readonly Theme[] = ['hyrak', 'dark', 'midnight', 'light']
// The dark theme the quick light/dark switches return to.
const LAST_DARK_KEY = 'hyrak-last-dark-theme'

const ThemeContext = createContext<{
    theme: Theme
    setTheme: (t: Theme) => void
    toggleLight: () => void
}>({
    theme: DEFAULT_THEME,
    setTheme: () => {},
    toggleLight: () => {},
})

// Replaces next-themes with the same behavior (class on <html>, dark default,
// no system detection, localStorage key 'theme' - existing saved preferences
// keep working) but WITHOUT rendering a <script> tag from a client component,
// which React 19 warns about on every page load. The before-paint theme init
// lives as a real inline script in app/layout.tsx <head>.
function readSavedTheme(): Theme {
    try {
        const saved = localStorage.getItem('theme')
        if (THEMES.includes(saved as Theme)) return saved as Theme
    } catch { /* storage unavailable */ }
    return DEFAULT_THEME
}

function lastDarkTheme(): Theme {
    try {
        const saved = localStorage.getItem(LAST_DARK_KEY)
        if (saved && saved !== 'light' && THEMES.includes(saved as Theme)) return saved as Theme
    } catch { /* storage unavailable */ }
    return DEFAULT_THEME
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    // The saved theme is read hydration-safely; a pick in this session
    // overrides it until the next load (by which time it IS the saved one).
    const saved = useClientValue(readSavedTheme, DEFAULT_THEME)
    const [picked, setPicked] = useState<Theme | null>(null)
    const theme = picked ?? saved

    const setTheme = (t: Theme) => {
        setPicked(t)
        try {
            localStorage.setItem('theme', t)
            if (t !== 'light') localStorage.setItem(LAST_DARK_KEY, t)
        } catch { /* not critical */ }
        const root = document.documentElement
        root.classList.remove('dark', 'light', 'midnight', 'hyrak')
        if (t === 'light') root.classList.add('light')
        else root.classList.add(...(t === 'dark' ? ['dark'] : ['dark', t]))
        root.style.colorScheme = t === 'light' ? 'light' : 'dark'
    }

    // The rail's quick switch: light, or back to whichever dark theme was last used.
    const toggleLight = () => setTheme(theme === 'light' ? lastDarkTheme() : 'light')

    return <ThemeContext.Provider value={{ theme, setTheme, toggleLight }}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)
