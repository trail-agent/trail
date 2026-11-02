#!/usr/bin/env node
// Entry point for the `trail` command.

import { runCli } from "./cli.ts"

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  },
)
