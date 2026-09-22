const entry = {anyOf: [{type: "string"}, {type: "object"}, {type: "array"}, {type: "null"}]};
const base = {id: {type: "string", minLength: 1}, prompt: entry};
/** Tool discovery describes the public contract; runtime validation enforces adapter limits. */
export const decisionRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "requestId", "state", "questions"],
  properties: {
    schemaVersion: {const: "2"},
    requestId: {type: "string", minLength: 1},
    state: {description: "Explicitly supplied JSON state. No implicit file or environment access."},
    questions: {
      type: "array", minItems: 1, maxItems: 128,
      items: {oneOf: [
        {type: "object", additionalProperties: false, required: ["id", "kind", "prompt", "options"], properties: {
          ...base, kind: {const: "choice"}, options: {type: "array", minItems: 2, maxItems: 255, items: {
            type: "object", additionalProperties: false, required: ["id", "label"], properties: {
              id: {type: "string", minLength: 1}, label: {type: "string", minLength: 1}, description: entry,
            },
          }},
        }},
        {type: "object", additionalProperties: false, required: ["id", "kind", "prompt"], properties: {
          ...base, kind: {const: "boolean"}, criteria: {type: "object", additionalProperties: false, required: ["true", "false"], properties: {true: entry, false: entry}},
        }},
        {type: "object", additionalProperties: false, required: ["id", "kind", "prompt", "min", "max"], properties: {
          ...base, kind: {const: "ordinal"}, min: {type: "number"}, max: {type: "number"}, step: {type: "number", exclusiveMinimum: 0, default: 1},
          levels: {type: "array", minItems: 2, maxItems: 10, items: entry, description: "One description per evenly spaced value from min to max. The response separates modal selected from continuous expected."},
        }},
      ]},
    },
  },
} as const;
