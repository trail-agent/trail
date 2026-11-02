// The complete tool's schema. The core executes it, because validation needs the event log.

import type { ToolSpec } from "@trail-agent/protocol"

export const COMPLETE_TOOL_NAME = "complete"

export const completeSpec: ToolSpec = {
  name: COMPLETE_TOOL_NAME,
  description: [
    "Finish the task with a report. Every claim must cite evidence ids (ev_N) shown at the end of earlier tool results; the harness checks them and rejects claims it cannot verify.",
    "Claim kinds:",
    "- tests_passed: cite the test command run AFTER your last file change in that workspace (exit code 0).",
    "- command_succeeded: cite a command with exit code 0.",
    "- file_changed: cite the write/edit of that file.",
    "- service_healthy / observed: cite the command or read that showed it.",
    "- unverified: something you believe but could not check; allowed, but shown to the user as unverified.",
    "If a claim is rejected, gather the missing evidence (for example re-run the tests) and call complete again.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "What was done, in one or two sentences" },
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            kind: {
              type: "string",
              enum: ["tests_passed", "command_succeeded", "file_changed", "service_healthy", "observed", "per_docs", "unverified"],
            },
            evidence: { type: "array", items: { type: "string" } },
            workspace: { type: "string" },
          },
          required: ["text", "kind", "evidence"],
        },
      },
    },
    required: ["summary", "claims"],
  },
}
