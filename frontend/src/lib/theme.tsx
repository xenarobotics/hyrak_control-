'use client'

import { createContext, useContext, useEffect, useState } from 'react'

type Theme = 'dark' | 'light'

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
        if (saved === 'light' || saved === 'dark') setThemeState(saved)
    }, [])

    const setTheme = (t: Theme) => {
        setThemeState(t)
        localStorage.setItem('theme', t)
        const root = document.documentElement
        root.classList.remove('dark', 'light')
        root.classList.add(t)
        root.style.colorScheme = t
    }

    return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)
