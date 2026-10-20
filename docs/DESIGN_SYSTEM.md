# HYRAK design system

One set of rules for every screen, in dark and light mode. HYRAK is used by
pilots in bright sun and dark rooms, by engineers and by customers who have
never flown, so readability beats density and decoration every time.

## 1. Typeface

- **Nunito** for everything: headings, body, labels, numbers, buttons.
- Numbers that change (telemetry, timers, percentages, coordinates) use
  `font-variant-numeric: tabular-nums` so they do not jitter. This replaces
  the old monospace look.
- A monospace face only for real code or raw values a user may copy
  (MAVLink ids, commands, file names): the `font-code` utility.
- No italics, except quoting what a user typed.
- Weights: 400 body, 600 emphasis and labels, 700 headings and key numbers,
  800 only for the one most important number on a screen. Never 300 or less.

## 2. Type scale

| token   | size | line height | use |
|---------|------|-------------|-----|
| `--fs-2xs` | 12px | 16px | (kept for compatibility: same as xs) |
| `--fs-xs`  | 12px | 16px | labels, chips, captions, table headers (the minimum for anything a user reads) |
| `--fs-sm`  | 13px | 18px | secondary text, help lines, list metadata |
| `--fs-base`| 14px | 20px | body text, inputs, buttons |
| `--fs-md`  | 16px | 22px | card titles, important values |
| `--fs-lg`  | 18px | 24px | panel titles |
| `--fs-xl`  | 22px | 28px | page titles, hero numbers |
| `--fs-2xl` | 28px | 34px | the single main readout (altitude, speed) |

Rules: nothing below 12px anywhere. Help text is 13px. Body 14px. Section
labels 12px 700, uppercase allowed with at most 0.06em tracking (no
wide-tracked tiny mono). Every screen has a visible hierarchy: page or
panel title 18-22px 700, primary readouts 22-28px 700-800, body 14px,
secondary 13px, labels 12px.

## 3. Colour

Tokens live in `globals.css` and are the only colours components use
(`text-app-text`, `bg-app-surface`, `text-app-accent` ...). No raw
`zinc-500`, `gray-600`, `white/40` or inline rgba for text.

Contrast targets (WCAG 2.2): body and muted text >= 4.5:1 on every surface
they sit on (aim 7:1 for body); large/bold text and icons >= 3:1; borders
that separate content >= 1.5:1, input borders and focus rings >= 3:1.

| token | role |
|-------|------|
| `--app-bg`, `--app-surface`, `--app-surface-2`, `--app-raised` | page, panels, insets, popovers (lighter = higher in dark mode; white cards on tinted page in light) |
| `--app-border`, `--app-border-strong` | separators, then inputs and focusable edges |
| `--app-text` | primary text |
| `--app-text-muted` | secondary text, >= 4.5:1 on surface-2 |
| `--app-text-subtle` | tertiary (placeholders, disabled hints), >= 3:1, never for information that matters |
| `--app-accent`, `--app-accent-ink`, `--app-accent-soft` | primary action and selection |
| `--app-ok`, `--app-warn`, `--app-danger` (+ `-soft`, `-ink`) | status; each passes 4.5:1 as text on surface in its theme |

Semantic use: cyan accent = interactive / selected; green = healthy / done;
amber = caution, and anything that moves the drone or can hurt someone;
red = danger, failure, kill. Colour never carries meaning alone: pair it
with an icon or a word.

## 4. Space, shape, elevation

- 4px grid: 4, 8, 12, 16, 24, 32. Panels pad 16; dense rails 12.
- Radius: 6 small controls, 10 cards and panels, 14 sheets and dialogs,
  999 pills. One radius per level.
- Elevation in dark mode by lighter surface + 1px border; in light mode by
  white surface + border + soft shadow `0 1px 2px rgb(0 0 0 / .06), 0 4px 12px rgb(0 0 0 / .05)`.
- Touch targets >= 32px (40px on touch-first screens and Normal mode).

## 5. Motion

- Durations: 120ms (hover, press), 180ms (toggles, chips, expand), 240ms
  (panels, sheets, toasts). Nothing over 300ms except a deliberate progress.
- Easing: `cubic-bezier(.2, .8, .2, 1)` entering, `cubic-bezier(.4, 0, 1, 1)` leaving.
- Animate opacity and transform only. No layout-shifting animation.
- `prefers-reduced-motion`: no movement, opacity only or instant.

## 6. Layout and hierarchy

- One primary action per panel (filled accent button); others are outline
  or ghost. Destructive actions are red outline until confirmed.
- Titles say what the thing is in plain words; detail goes in tooltips and
  disclosure, not paragraphs.
- Numbers: value large and bold, unit small and muted right after it.
- Status reads in 1 second: icon + word + colour, top of the panel.
- Empty states: an icon, one line, one action.

## 7. Dark and light

Every component is checked in both. Hard-coded dark colours (`bg-black/70`,
`text-white`, `rgba(17,19,24,.9)`) are only allowed on surfaces that are
always dark by design (video, map overlays), and those must still use the
dark token values.

## 8. States

- **Disabled** never relies on opacity alone: text stays >= 4.5:1
  (`--app-text-subtle` on `--app-surface-2`, dashed or plain border), the
  control keeps its label, and a tooltip says why it is disabled ("Connect
  a drone first", "Land before testing").
- **Focus**: a 2px `--app-accent` ring with 2px offset on every interactive
  element, including toolbars over video and maps.
- **Loading** follows the loaders rule: nothing under 100ms, inline spinner
  to 1s, skeleton beyond.
- Never show a progress or readiness number that is not measured (no "67%
  READY" with no drone).

## 9. Over video and maps (always-dark surfaces)

Text and controls drawn over video or map tiles use a fixed set, the same
in both themes, on a scrim:

| token | value |
|-------|-------|
| `--overlay-scrim` | `rgba(8, 12, 18, 0.72)` with `backdrop-filter: blur(6px)` |
| `--overlay-text` | `#F2F6FA` |
| `--overlay-muted` | `#C3CCD8` |
| `--overlay-border` | `rgba(255, 255, 255, 0.18)` |
| accents | the dark-theme accent, ok, warn, danger values |

Never place theme tokens (`text-app-text`) on these surfaces: in light mode
they turn dark-on-dark.

## 10. Layout across widths

- One status bar component for the whole app (Fly, Command, Mission, AI,
  Config, Admin), not one per page.
- One page shell, including the admin console (no separate dark-only shell).
- Below 768px: the side rail becomes a bottom tab bar; status chips
  collapse into one summary chip that opens a sheet; LAND and KILL stay
  visible at all times; no horizontal page scroll.
- Maps open on the drone, else the workspace's area, else the user's last
  view. Never (0, 0).

## 11. Visual direction (pass 2): the glass cockpit

HYRAK is a ground station. Its look comes from the instrument panels pilots
already trust, not from a SaaS dashboard kit.

**Colour language** (glass-cockpit convention, so it carries meaning):

| role | dark | light | meaning |
|------|------|-------|---------|
| cyan | `#4FD1E0` | `#0B6F80` | selectable, selected, what the pilot set |
| magenta | `#E08AF5` | `#9B1FA8` | the active route, the active target, what HYRAK is following |
| green | `#5BD38B` | `#1D7444` | engaged, healthy, done |
| amber | `#F2B544` | `#8F5500` | caution, and anything that moves the drone or can hurt someone |
| red | `#F2787A` | `#B42323` | warning, failure, kill |

**Surfaces** (never pure black or pure white). Midnight is a deeper,
higher-contrast dark (page `#0B0D11`, text `#FFFFFF`).

| role | dark ("night sortie") | light ("overcast day") |
|------|------|-------|
| page | `#12171E` | `#E9EEF3` |
| panel | `#19202A` | `#F8FAFC` |
| inset | `#1F2833` | `#EFF3F7` |
| raised (popovers) | `#242E3A` | `#FCFDFE` |
| line | `#313C4B` | `#C9D3DE` |
| strong line, inputs | `#6B7989` | `#7B8797` |
| ink / ink-2 / ink-3 | `#EAF0F6` / `#B4BFCC` / `#8E9AA9` | `#16202C` / `#45525F` / `#5E6B79` |

Every ink and colour above passes 4.5:1 on every surface of its theme.

**Overlays follow the theme.** Over maps and video in light mode: frosted
paper (`rgb(248 250 252 / .86)`) with dark ink; in dark mode frosted night
(`rgb(18 23 30 / .78)`) with light ink. The area around live video is slate
`#1A2129` in both themes; with no video, the placeholder is the theme's
inset colour with an icon and one line, never a black box. The 3D globe
uses daylight in light mode.

**Type.** Nunito only. Labels are sentence case, 12-13px 600-700, no
tracking (all-caps only for aviation status words: ARMED, HOLD, RTL, LAND,
KILL). Readouts 22-28px 800 with a 12px muted unit. No middle-dot meta
strings: use separate chips or a small key/value grid.

**Layout.** One status bar for every page: read-only status on the left
(grey "-" when there is no drone, red only for real faults), and HOLD, RTL,
LAND and KILL fixed at the right edge, KILL the strongest, named "Kill" the
same everywhere. Flight screens (Fly, Command, Mission): the live view
(video or map) dominates, readouts sit beside it at eye level, one-time
setup collapses into a strip. Setup screens (AI, Config, Settings, Admin):
section navigation on the left, content up to 960px, cards only for real
groups (no card soup, no identical shadow on everything).

**Motion answers the user.** Hover: colour and border 140ms. Press: scale
.98 for 90ms. Panels and sheets: slide and fade 220ms. Toasts: 240ms in,
180ms out. Tabs: the underline slides. Nothing moves on its own except a
single pulse when the link state changes.
