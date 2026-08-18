#!/usr/bin/env node
// CLI entry point for the globally installed tool.

import { startServer } from '../server.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

const HELP = `
  claude-memory-admin - browse and prune Claude Code's auto memory

  Usage
    claude-memory-admin [options]

  Options
    -p, --port <n>    port to listen on            (default 4173)
    -r, --root <dir>  memory store to read         (default ~/.claude/projects,
                      or autoMemoryDirectory from ~/.claude/settings.json)
        --no-open     do not launch a browser
    -h, --help        show this help
    -v, --version     print the version

  The store is read from disk on every request. The only writes are deletes,
  restores, and clearing a broken link - each one reversible from the Trash tab.
`;

function parseArgs(argv) {
  const options = { port: undefined, root: undefined, open: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }
      return value;
    };
    switch (arg) {
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      case '-v': case '--version': console.log(pkg.version); process.exit(0); break;
      case '-p': case '--port': options.port = Number(next()); break;
      case '-r': case '--root': options.root = next(); break;
      case '--no-open': options.open = false; break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}\n${HELP}`);
          process.exit(1);
        }
    }
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    console.error(`Invalid port: ${options.port}`);
    process.exit(1);
  }
  return options;
}

startServer(parseArgs(process.argv.slice(2)));
