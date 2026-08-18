# alpha Project Memory

## Build / Tooling Notes

- [Alpha setup](alpha-setup.md) — postcss lives at the root and the theme file is imported, not configured
- [Beta conventions](beta-conventions.md) — repositories cross boundaries; feature flags stay plain booleans

## Architecture Overview

- **Frontend**: app under `apps/alpha/src/`
  - Styling is CSS-first — see [inline only](inline-only.md): the theme file is the single source
  - No global registry; each surface owns its tokens
- Dialogs inject `DialogRef`, never construct their own overlay

## Conventions

- [CRM Tasks Feature](flat-frontmatter.md) — entity, service methods and pages
