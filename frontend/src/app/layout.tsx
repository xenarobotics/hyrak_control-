import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { ThemeProvider } from '@/lib/theme'
import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'HYRAK',
  description: 'Cloud-native drone intelligence',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before first paint (no flash). A plain
            inline script in the SSR head runs synchronously before paint;
            next/script's beforeInteractive doesn't support inline code.
            suppressHydrationWarning keeps React from diffing it. */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('theme');t=t==='light'?'light':'dark';var d=document.documentElement;d.classList.add(t);d.style.colorScheme=t}catch(e){}",
          }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`} suppressHydrationWarning>
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}