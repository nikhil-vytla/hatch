Recorded wire payloads, each in the shape that once destroyed a paid episode.

Every file here is a regression fixture for `parallax.hud_wire`. The
`*-summary.json` receipts under
`parallax/research/swebench-single-vs-evolved-20260803/evidence/` record what
each defect cost when it was discovered live.

| fixture | quirk | cost when discovered |
| --- | --- | --- |
| `delivery-receipt-json-arrays.json` | tuple fields arrive as JSON arrays; strict python-mode validation rejects them | ~$0.40-0.80 of unmetered episodes |
| `provider-null-tool-calls.json` | `tool_calls: null` where an array is declared | provider responses unparseable |
| `construction-fenced-json.txt` | model output wrapped in a Markdown JSON fence | construction rejected |
| `construction-bare-json.txt` | the same payload unfenced, so fence stripping cannot corrupt the normal case | — |
