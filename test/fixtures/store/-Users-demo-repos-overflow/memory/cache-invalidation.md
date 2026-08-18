---
name: cache-invalidation
description: Permission reads are cached per request, cleared on write
metadata:
  type: project
---

Permission reads are cached per request, cleared on write. This note exists so
the overflow fixture has real memory files behind its index entries rather
than a wall of dangling pointers.
