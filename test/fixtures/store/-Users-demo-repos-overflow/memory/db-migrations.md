---
name: db-migrations
description: Migrations run on startup in dev and never in prod
metadata:
  type: project
---

Migrations run on startup in dev and never in prod. This note exists so the
overflow fixture has real memory files behind its index entries rather than a
wall of dangling pointers.
