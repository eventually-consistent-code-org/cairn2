---
type: gotcha
provenanceFiles: [docs/diagrams/cairn-in-claude.excalidraw, docs/diagrams/cairn-workflow.excalidraw]
provenanceCommits: [5903bce, 5903bce]
created: 2026-09-20
scopePhase: 24.5
confidence: medium
---
Before trusting a new diagram render, render an UNCHANGED .excalidraw first and compare byte sizes with the committed PNG. On 2026-09-20 the global excalidraw skill's renderer reproduced cairn-in-claude.png at exactly 905981 bytes, identical to the committed file — which proves the toolchain (pinned esm.sh @0.18.0, headless chromium) is intact before any judgement about a new render is made. Cheap, and it separates "my JSON is wrong" from "the renderer changed under me".

Two things the JSON cannot tell you, both of which shipped defects into a first render this phase: text overflowing its container past the canvas edge, and a shape overlapping text that sits behind it. A scripted overlap check over element bounding boxes catches the second class quickly — filter out the intentional cases (a text element inside its own container) and anything left is a real collision. The first class needs the rendered image.

Also: diagrams argue better when a decorative connector is cut. An arc drawn between two related labels in the workflow diagram collided with tick lines, body text, and an existing label; the information was already carried by the two text blocks, so removing the arc improved the diagram. Check free space with the same bounding-box script BEFORE drawing a connector into a dense lane.

`node scripts/check-diagrams.mjs` only guards count-shaped labels ("N typed tools", "N backends"), so it stays green through any amount of visual breakage. It is not a render check.
