'use client'

import { createContext, useContext, useEffect, useState } from 'react'

// 'dark' is the original palette, kept untouched as the classic default.
// 'midnight' is the reworked dark — same shadcn variables (it stacks the
// .dark class), higher-contrast app tokens. 'light' is the bright theme.
type Theme = 'dark' | 'midnight' | 'light'

const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
    theme: 'dark',
    setTheme: () => {},
})

// Replaces next-themes with the same behavior (class on <html>, dark default,
// no system detection, localStorage key 'theme' — existing saved preferences
// keep working) but WITHOUT rendering a <script> tag from a client component,
// which React 19 warns about on every page load. The before-paint theme init
// lives as a real inline script in app/layout.tsx <head>.
export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [theme, setThemeState] = useState<Theme>('dark')

    useEffect(() => {
        const saved = localStorage.getItem('theme')
        if (saved === 'light' || saved === 'dark' || saved === 'midnight') setThemeState(saved)
    }, [])

    const setTheme = (t: Theme) => {
        setThemeState(t)
        localStorage.setItem('theme', t)
        const root = document.documentElement
        root.classList.remove('dark', 'light', 'midnight')
        // midnight KEEPS the .dark class: the shadcn variable block and every
        // `dark:` utility follow it, and midnight only re-tints the app tokens.
        if (t === 'midnight') root.classList.add('dark', 'midnight')
        else root.classList.add(t)
        root.style.colorScheme = t === 'light' ? 'light' : 'dark'
    }

    return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)
