// lib/rpc.js
//
// The RPC contract between the server part and the Desktop GUI part. The server
// registers it in V2 setup (lib/desktop.js) and the GUI calls it through
// `ctx.client.rpc()`; it is also published as the `./rpc` export so other
// plugins and clients can call it without loading the implementation.
//
// JSON Schema only. A Standard Schema validator (zod/valibot) would give
// inferred TypeScript types but adds a runtime dependency to the published
// package; every consumer here casts the one response it reads anyway, and the
// app validates both formats identically.
//
// The wire shape is FLAT on purpose: `lib/desktop.js` builds every row from one
// report, and the T30 gate check compares the schema keys with that builder's
// output keys, so a field added to one side without the other fails the gate.

import { Rpc } from "@opencode/plugin/rpc"

const ROW_PROPERTIES = {
  // Session ids and the parent link, as reported by the state snapshot.
  sessionID: { type: "string" },
  // "" for the root session (JSON has no undefined; nulls would need a union
  // type every consumer has to narrow).
  parentID: { type: "string" },
  agent: { type: "string" },
  modelID: { type: "string" },
  providerID: { type: "string" },
  // Token counts. `usable` and `reserve` are 0 when the window is unknown.
  ctx: { type: "number" },
  input: { type: "number" },
  usable: { type: "number" },
  reserve: { type: "number" },
  // The eight breakdown categories, in tokens.
  user: { type: "number" },
  assistant: { type: "number" },
  reasoning: { type: "number" },
  toolArgs: { type: "number" },
  toolOut: { type: "number" },
  system: { type: "number" },
  toolSchemas: { type: "number" },
  other: { type: "number" },
  // Provenance of the numbers and the measurement time ("" when unknown).
  source: { type: "string" },
  updatedAt: { type: "string" },
  // True when the session was compacted after this measurement.
  stale: { type: "boolean" },
}

const ROW_REQUIRED = Object.keys(ROW_PROPERTIES)

export const DesktopContextRpc = Rpc.define({
  // Same id as the plugin itself: one RPC per plugin keeps the event names and
  // client subclients unambiguous.
  id: "context-indicator",
  methods: {
    // Root session plus every descendant that has a measurement, in the same
    // order /context-breakdown uses (root first, then breadth-first children).
    family: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: ROW_PROPERTIES,
              required: ROW_REQUIRED,
              additionalProperties: false,
            },
          },
        },
        required: ["rows"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})

// Exported for the T30 gate check (schema/row drift) without a second copy of
// the key list.
export const DESKTOP_ROW_KEYS = ROW_REQUIRED
