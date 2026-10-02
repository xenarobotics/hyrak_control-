import type { Metadata } from 'next'
import { Geist, Geist_Mono, Ubuntu, Inter, Nunito, Atkinson_Hyperlegible_Next } from 'next/font/google'
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

// Self-hosted at build time so the font preference works offline - a ground
// station in a field must not depend on a fonts CDN.
const ubuntu = Ubuntu({
  variable: '--font-ubuntu',
  subsets: ['latin'],
  weight: ['400', '500', '700'],
})

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
})

const nunito = Nunito({
  variable: '--font-nunito',
  subsets: ['latin'],
})

// Normal mode's typeface: designed by the Braille Institute for readers with
// low vision - unambiguous letter shapes (I/l/1, O/0) at a glance.
const atkinson = Atkinson_Hyperlegible_Next({
  variable: '--font-atkinson',
  subsets: ['latin'],
  weight: ['400', '500', '700', '800'],
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
              "try{var t=localStorage.getItem('theme');var d=document.documentElement;if(t==='midnight'){d.classList.add('dark','midnight');d.style.colorScheme='dark'}else{t=t==='light'?'light':'dark';d.classList.add(t);d.style.colorScheme=t}var f=localStorage.getItem('hyrak-ui-font');if(f&&f!=='default')d.dataset.font=f;var z=Number(localStorage.getItem('hyrak-ui-zoom'));if(z&&z!==100)d.style.zoom=String(z/100);var ts=localStorage.getItem('hyrak-ui-textsize');if(ts&&ts!=='default')d.dataset.fontsize=ts}catch(e){}",
          }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} ${ubuntu.variable} ${inter.variable} ${nunito.variable} ${atkinson.variable} antialiased`} suppressHydrationWarning>
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}