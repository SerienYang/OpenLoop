# Design System

## Theme

OpenLoop is a restrained product interface for prolonged desktop work. It uses cool monochrome
surfaces and avoids decorative color. Dark and light themes share the same hierarchy and component
geometry.

## Color

- Use the existing OKLCH `--accent`, `--accent-soft`, and `--on-accent` tokens for selection,
  primary actions, focus, checkmarks, and radio dots.
- Use `--paper`, `--panel`, `--line`, `--line-strong`, `--ink`, `--muted`, and `--faint` for
  structure and hierarchy.
- Reserve semantic green, amber, and red for status, warning, and destructive states.
- Do not introduce saturated blue as a general product accent.

## Typography

- Product UI uses the system sans stack.
- Manrope is reserved for the OpenLoop wordmark.
- Labels use compact product scale and weight contrast; supporting text uses muted color and
  relaxed line height.

## Layout

- Settings use a fixed left sub-navigation and a centered content column.
- Form rows use a stable 20px control column followed by text content.
- Labels and descriptions align to the same x-coordinate across checkbox and radio groups.
- Cards group genuinely related settings; avoid nested cards without a distinct interaction state.

## Controls

- Checkbox and radio inputs keep native HTML semantics and keyboard behavior.
- Their native glyph is visually replaced by a consistent 16px control in a 20px alignment column.
- Selected controls use monochrome accent tokens. Focus uses a visible token-based focus ring.
- Navigation icons use the shared 24px, 1.7-stroke line icon system.
- Privacy and security uses the shield icon, not a decorative sparkle.

## Localization

- Chinese mode must not fall back to English for user-visible copy routed through `t()`.
- Brand names, model names, OS names, file paths, IDs, and protocol terms may remain unchanged
  when translation would reduce accuracy.
- Layout must tolerate both Chinese and English without clipping or control misalignment.

## Motion

- State transitions remain between 150ms and 250ms.
- Motion communicates state only and respects reduced-motion preferences.
