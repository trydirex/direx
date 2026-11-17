# Direx web design

How the web app looks, and the rules that keep it consistent. The tokens live in
`src/styles.css`; this file explains them. To see them, run `bun run dev` and open
`http://localhost:5173/tokens.html`.

**Status (2026-11-11):** this file describes "Steep", the direction the founder chose on
2026-11-10 (serif analytics on warm paper), replacing "Mailroom". On 2026-11-11 the greys were warmed for a marketer audience. `src/styles.css` holds its tokens, and the components are Meta's Astryx (ADR 0020), drawn
with those tokens.

## The look

A mail client for approvals. The queue sits on one side and the selected Item on the other, shown
as the person who receives it will see it. Warm and quiet: a paper page, white panels, warm ink text,
an ink accent and a clay tint on the selected row and nav item. Inter for reading, Source Serif 4 at weight 400 for titles, hairline borders, pill
buttons, soft 20px cards. One warm peach callout (`peach` with `peach-foreground`) at most per screen.
Only dialogs, drawers and toasts carry a soft shadow; menus and popovers keep the hairline. Colour is otherwise spent on
state; red is for errors and Pause all sending.

## Layout

- A 72px rail of icons with their names under them on the left. The Workspace menu sits at its top; Search (Ctrl K), Brand and
  Settings at its foot. Section links show their name; Workspace, Search and Ask keep a tooltip, and the page title always
  names the section.
- List screens have two panes: the list (about 380px) and the selected thing. Home is an overview of what
  needs you, with the clean drafts ticked to approve together after a list of each one. Review (`/review`) is the
  queue with the first Item open.
- Each screen's top bar holds its actions on the left and Pause all sending on the right.
- Below 1100px the panes stack and the selected thing opens as its own page.

## Tokens

Only these exist. Tailwind's default theme is reset, so `bg-blue-500`, `shadow-md` or
`rounded-lg` produce nothing. Colours are stored as hex, which the contrast test reads.

| Kind | Tokens |
|---|---|
| Text colour | `foreground` `#1c1a17` (body and titles), `muted-foreground` `#6b665d` (secondary) |
| Surfaces | `background` `#f8f6f2` (paper page), `card` and `popover` `#ffffff` (panels), `muted`, `secondary` and `accent` `#f1eee8` (linen: Held, hover, quiet cards); each has a `-foreground`. `peach` `#fbe1d1` with `peach-foreground` `#5d2a1a`: one editorial callout per screen, on white or paper only |
| Lines | `border` `#e9e4dc` (dividers, card outlines), `input` `#8a8378` (control outlines, 3:1) |
| Accent | `primary` `#1c1a17` (ink) with white text, `primary-tint` `#f3e6dc` (clay: selected row and nav item, quiet chips), `ring` (focus) |
| States | `StateChip` gives each state a colour and a shape: Needs approval a dot on `peach` (peach now means "needs you"), Scheduled a ring on `scheduled-tint` `#e3ecf5` in `scheduled` `#2f5d8a`, Sent and Applied a check on `success-tint`, Held two bars on `muted`, Blocked a diamond (Postmark, 2026-11-12) |
| Signals | `success` `#267b4c` on `success-tint` `#daf7e3` (Sent, Applied); `warning` `#975800` on `warning-tint` `#fef0d4`; `destructive` `#c1332c` (errors, and Pause all sending; founder, 2026-11-09) |
| Channels | `channel-email` teal, `channel-post` blue, `channel-newsletter` amber, `channel-seo` raspberry: Calendar blocks and `ChannelMark` tiles (a white glyph on the channel colour, always with its name as a label), never text on their own |
| Type | Inter: `text-xs` 12, `text-sm` 14 (secondary), `text-base` 15 (body), `text-md` 17 (a card or form section's heading, the Calendar's day numbers). Source Serif 4, weight 400, tracking -0.015em: `text-lg` 22 (section title), `text-xl` 30 (page title). Times and counts use tabular figures |
| Spacing | a 4px grid: `p-2` is 8px, `gap-4` is 16px |
| Radius | `rounded-sm` 4 (kbd, small tags, state chips), `rounded-control` 8 (buttons, inputs), `rounded-card` 12 (cards, panels, previews), `rounded-full` (filter pills and count badges only), so a button, a filter and a state never look alike (Postmark, 2026-11-12) |
| Sizes | controls 32px, small controls 26px, 44px on touch widths; nothing clickable under 24px |

Every text pair above is at least 4.5:1 and `input` is at least 3.2:1 on paper, linen and white (checked 2026-11-11).

## Astryx (ADR 0020)

Interactive parts are Astryx components, imported by their own path (`@astryxdesign/core/Dialog`). Our
wrappers keep the props screens already pass: `components/Button.tsx` (with `buttonVariants` for a
router Link that looks like a button), `components/toast.tsx` (`toast.add`), and `shell/RailTip.tsx`.
Text and value fields are Astryx's too, through `components/Input.tsx`: `Input` and `Textarea` take a
native field's props and pick TextInput, TextArea, NumberInput, DateInput, TimeInput, DateTimeInput or
FileInput by `type`, and `Select` takes `<option>` children and renders Astryx's Selector; a named field
still reaches FormData, and a form reset clears it. Inside `Field` they show Field's label and hint. Astryx loads with the signed-in shell, so the pages before it (sign-in, a reset, an invite, a new organization)
use `components/native.tsx` (NativeButton, NativeInput, NativeTextarea) and no other Astryx part. Astryx draws with its own variables, so `src/astryx.css` sets each one it uses to one of our tokens, on
`[data-astryx-theme]` in a layer after its theme. This table and that file must agree; `styles.test.tsx`
checks they do and that every token on the right exists. Never set an Astryx variable to a raw value
other than `none`, and never style Astryx through its internal class names.

| Astryx variable | Our token |
|---|---|
| `--color-accent` | `--primary` |
| `--color-accent-muted` | `--primary-tint` |
| `--color-on-accent` | `--primary-foreground` |
| `--color-text-accent` | `--primary` |
| `--color-icon-accent` | `--primary` |
| `--color-text-primary` | `--foreground` |
| `--color-text-secondary` | `--muted-foreground` |
| `--color-icon-primary` | `--foreground` |
| `--color-icon-secondary` | `--muted-foreground` |
| `--color-background-body` | `--background` |
| `--color-background-surface` | `--card` |
| `--color-background-card` | `--card` |
| `--color-background-popover` | `--popover` |
| `--color-background-muted` | `--muted` |
| `--color-background-muted` | `--muted` |
| `--color-skeleton` | `--muted` |
| `--color-neutral` | `--secondary` |
| `--color-border` | `--border` |
| `--color-border-emphasized` | `--input` |
| `--color-success` | `--success` |
| `--color-success-muted` | `--success-tint` |
| `--color-text-success` | `--success` |
| `--color-warning` | `--warning` |
| `--color-warning-muted` | `--warning-tint` |
| `--color-text-warning` | `--warning` |
| `--color-error` | `--destructive` |
| `--color-error-muted` | `--destructive-tint` |
| `--color-on-error` | `--destructive-foreground` |
| `--color-text-error` | `--destructive` |
| `--color-border-error` | `--destructive` |
| `--radius-inner` | `--radius-sm` |
| `--radius-element` | `--radius-control` |
| `--radius-container` | `--radius-card` |
| `--shadow-low` | `--edge` |
| `--shadow-med` | `--lift` |
| `--shadow-high` | `--lift-high` |
| `--font-family-body` | `--font-sans` |
| `--font-family-heading` | `--font-display` |
| `--font-family-code` | `--font-mono` |
| `--font-size-base` | `--text-base` |
| `--focus-outline-color` | `--ring` |
| `--focus-outline-offset` | `--ring-offset` |

`--color-background-muted` is listed twice because `astryx.css` sets it twice: once for every component, and again on the progress bar, whose track the neutral theme otherwise draws in the strong border, so an empty bar would look full.

## Rules

1. Use a token class. No hex colour, no arbitrary value (`p-[13px]`, `text-[#f00]`), no inline
   `style` except for computed layout.
2. Interactive parts (button, dialog, drawer, menu, popover, select, tabs, tooltip, toast, table,
   skeleton, palette) come from Astryx. Don't build your own, and don't import another kit;
   `check:web-rules` refuses Base UI, Radix, React Aria and Headless UI.
3. An Item's state is always a `StateChip`, which writes the state name, so colour is never the only
   signal.
4. Focus is always visible: the `ring` outline, 2px, offset 2px. Never remove it.
5. Every keyboard shortcut is also a button, and none fires inside a text field.
6. Motion is short and only shows where something came from; `prefers-reduced-motion` turns it off.
7. Words come from `GLOSSARY.md`; the `product-copy` skill checks them.
8. No glass or gradients. Depth comes from a white panel on the paper page; dialogs, drawers and toasts get
   the soft `lift` shadows, through Astryx. Menus and popovers keep the hairline, because Astryx draws
   them with the same shadow as its buttons.
9. The serif is for page and section titles only, always weight 400.
10. Show an Item as it will appear: an email in a mail-client frame, a post as a card per network.

## Item states

| State | Chip |
|---|---|
| Draft | dashed outline, secondary text |
| Needs approval | accent text on `primary-tint`: quiet, because on Home it is the default |
| Scheduled | outline, body text |
| Sent, Applied | green on a green tint |
| Held | `muted` fill, always with its reason ("Held: not sure it sent") |
| Blocked | dark grey fill, white text |
| Cancelled | light outline, secondary text |

Warnings show as an amber count ("1 warning") next to the chip, not as a chip of their own.

## Checking a screen

Before a screen is done: `web-design-guidelines` on its files, `impeccable` `detect` on the running
page, and the DOM tests for its loading, error and keyboard paths.
