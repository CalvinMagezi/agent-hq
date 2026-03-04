---
name: drawit
description: Use this skill whenever the user wants to create, edit, or analyze diagrams. This includes flowcharts, architecture diagrams, mind maps, org charts, ER diagrams, dependency graphs, codebase maps, sequence diagrams, and any visual diagram. If the user asks for a diagram, chart, or visual representation of structure or flow, use this skill.
---

# DrawIt Diagram Generation Guide

## Overview

DrawIt is a diagram system using NDJSON (newline-delimited JSON) `.drawit` files. The agent workflow is:

1. Plan the diagram layout (positions, sizes, connections)
2. Write NDJSON content (metadata line + element lines)
3. Call `hq_call("drawit_render", {name, content})` to save + export SVG + convert PNG
4. The returned `[FILE:]` marker auto-shares via Discord/WhatsApp

For codebase diagrams, use `hq_call("drawit_map", {path})` instead.
For quick flowcharts, use `hq_call("drawit_flow", {steps: [...]})`.

## NDJSON File Format

A `.drawit` file is newline-delimited JSON:
- **Line 1**: Metadata (canvas dimensions, background, name)
- **Lines 2+**: Elements (nodes first, then edges)

```
{"width":800,"height":600,"background":"#ffffff","metadata":{"name":"My Diagram","diagramType":"flowchart"}}
{"id":"n1","type":"node","position":{"x":100,"y":100},"size":{"width":200,"height":60},"shape":"rectangle","text":{"content":"Process","fontSize":14,"color":"#ffffff","textAlign":"center","verticalAlign":"middle"},"style":{"fillStyle":"#1e3a5f","strokeStyle":"#3b82f6","lineWidth":2},"zIndex":2}
{"id":"e1","type":"edge","source":"n1","target":"n2","style":{"strokeStyle":"#94a3b8","lineWidth":2,"routing":"orthogonal","arrowheadEnd":true},"zIndex":1}
```

## Node Element Schema

```json
{
  "id": "unique-string",
  "type": "node",
  "position": { "x": 100, "y": 100 },
  "size": { "width": 200, "height": 60 },
  "shape": "rectangle",
  "angle": 0,
  "zIndex": 2,
  "text": {
    "content": "Label",
    "fontSize": 14,
    "fontFamily": "sans-serif",
    "fontWeight": "normal",
    "color": "#333333",
    "textAlign": "center",
    "verticalAlign": "middle",
    "padding": 10
  },
  "style": {
    "fillStyle": "#e3f2fd",
    "strokeStyle": "#1976d2",
    "lineWidth": 2,
    "fillOpacity": 1,
    "strokeOpacity": 1,
    "cornerRadii": { "topLeft": 8, "topRight": 8, "bottomRight": 8, "bottomLeft": 8 },
    "lineDash": [],
    "shadowColor": "#00000033",
    "shadowBlur": 4,
    "shadowOffsetX": 2,
    "shadowOffsetY": 2
  },
  "metadata": {}
}
```

**Shapes**: `rectangle`, `ellipse`, `diamond`, `triangle`, `hexagon`, `star`, `polygon`, `icon`, `polyline`, `line`

**Text shorthand**: `"text": "Label"` works instead of the full object.

## Edge Element Schema

```json
{
  "id": "unique-string",
  "type": "edge",
  "source": "source-node-id",
  "target": "target-node-id",
  "label": {
    "text": "connects to",
    "fontSize": 12,
    "color": "#666666",
    "position": 0.5
  },
  "style": {
    "strokeStyle": "#64748B",
    "lineWidth": 2,
    "routing": "orthogonal",
    "cornerRadius": 8,
    "arrowheadEnd": true,
    "arrowheadStart": false,
    "lineDash": [],
    "strokeOpacity": 1
  },
  "zIndex": 1,
  "metadata": {}
}
```

**Routing**: `straight` (direct line), `orthogonal` (L-shaped, good for grids), `bezier` (smooth curves)

**Label shorthand**: `"label": "text"` works instead of the full object.

## Diagram Type Guidelines

### Flowchart
- Rectangles for processes, diamonds for decisions, ellipses for start/end
- Vertical layout, 40-100px gaps between nodes
- Colors: process `#1e3a5f`/`#3b82f6`, decision `#78350f`/`#fbbf24`, start `#065f46`/`#34d399`, end `#7f1d1d`/`#f87171`
- White text (`#e2e8f0`) on dark fills, dark background (`#0a0f1e`)
- Node sizes: 200x60 for processes, 180x80 for diamonds

### Architecture
- Large rectangles for services/systems, smaller for components
- Color by layer: frontend `#42a5f5`, backend `#66bb6a`, database `#ef5350`, external `#9e9e9e`
- Dashed edges (`lineDash: [5, 5]`) for async, solid for sync
- Label edges with protocol/method
- Horizontal or layered layout

### Mind Map
- Central node larger (250x80), branches radiate outward
- Bezier routing for organic feel
- Consistent colors per branch, decreasing sizes for subtopics
- Ellipses for all nodes, 120-150px between levels

### Org Chart
- Top-down hierarchy, CEO at top center
- Rectangles with name + title text
- 100px vertical spacing between levels
- Solid orthogonal lines for reporting

### ER Diagram
- Rectangles for entities (list attributes as text)
- Edge labels for cardinality: "1:N", "M:N", "1:1"
- Colors: entities `#e3f2fd`/`#1976d2`, relationships `#fff3e0`/`#ff9800`

### Sequence Diagram
- Actors as rectangles at top, evenly spaced (200px apart)
- Messages as labeled edges flowing left-to-right or right-to-left
- Solid edges for calls, dashed (`lineDash: [5, 5]`) for responses

### Network Diagram
- Diamonds for routers, rectangles for servers, ellipses for clients
- Label connections with bandwidth/protocol
- Color-code network segments

## Layout Guidelines

- **Canvas padding**: 80px on each side
- **Node gaps**: 40-100px (40 for compact, 100 for spacious)
- **Typical node sizes**: 200x60 processes, 180x80 diamonds, 120x60 small labels
- **zIndex**: edges at 1, nodes at 2 (nodes render on top of edges)
- **Canvas size**: Calculate from rightmost/bottommost node + padding
- **Center alignment**: For vertical flows, center nodes at `(canvasWidth - nodeWidth) / 2`

## Color Palettes

### Dark Theme (recommended for technical diagrams)
- Background: `#0a0f1e`
- Text: `#e2e8f0`
- Process: fill `#1e3a5f`, stroke `#3b82f6`
- Decision: fill `#78350f`, stroke `#fbbf24`
- Start: fill `#065f46`, stroke `#34d399`
- End: fill `#7f1d1d`, stroke `#f87171`
- Edges: `#94a3b8` at 0.8 opacity

### Light Theme
- Background: `#ffffff`
- Text: `#333333`
- Process: fill `#e3f2fd`, stroke `#1976d2`
- Decision: fill `#fff3e0`, stroke `#ff9800`
- Start: fill `#e8f5e9`, stroke `#4caf50`
- End: fill `#ffebee`, stroke `#f44336`
- Edges: `#64748B`

## Complete Example: 3-Step Flowchart

```
{"width":500,"height":400,"background":"#0a0f1e","metadata":{"name":"Simple Flow","diagramType":"flowchart"}}
{"id":"start","type":"node","position":{"x":150,"y":80},"size":{"width":200,"height":60},"shape":"ellipse","zIndex":2,"style":{"fillStyle":"#065f46","strokeStyle":"#34d399","lineWidth":2},"text":{"content":"Start","fontSize":14,"fontFamily":"sans-serif","color":"#e2e8f0","textAlign":"center","verticalAlign":"middle"}}
{"id":"process","type":"node","position":{"x":150,"y":180},"size":{"width":200,"height":60},"shape":"rectangle","zIndex":2,"style":{"fillStyle":"#1e3a5f","strokeStyle":"#3b82f6","lineWidth":2,"cornerRadii":{"topLeft":8,"topRight":8,"bottomRight":8,"bottomLeft":8}},"text":{"content":"Process Data","fontSize":14,"fontFamily":"sans-serif","color":"#e2e8f0","textAlign":"center","verticalAlign":"middle"}}
{"id":"end","type":"node","position":{"x":150,"y":280},"size":{"width":200,"height":60},"shape":"ellipse","zIndex":2,"style":{"fillStyle":"#7f1d1d","strokeStyle":"#f87171","lineWidth":2},"text":{"content":"End","fontSize":14,"fontFamily":"sans-serif","color":"#e2e8f0","textAlign":"center","verticalAlign":"middle"}}
{"id":"e1","type":"edge","source":"start","target":"process","zIndex":1,"style":{"strokeStyle":"#94a3b8","lineWidth":2,"arrowheadEnd":true,"strokeOpacity":0.8}}
{"id":"e2","type":"edge","source":"process","target":"end","zIndex":1,"style":{"strokeStyle":"#94a3b8","lineWidth":2,"arrowheadEnd":true,"strokeOpacity":0.8}}
```

## CLI Commands Reference

```bash
# Create a new diagram
drawit create diagram.drawit --width 800 --height 600 --template flowchart

# Validate a diagram
drawit validate diagram.drawit [--strict]

# Inspect diagram metadata
drawit inspect diagram.drawit [--elements]

# Export to SVG
drawit export diagram.drawit --format svg --output diagram.svg [--padding 20]

# Export to JSON (pretty-printed)
drawit export diagram.drawit --format json --output diagram.json

# Generate flowchart from steps (questions become diamonds)
drawit flow "Start" "Process data" "Valid?" "Save" "Done" --output flow.drawit

# Map a codebase to a diagram
drawit map ./src --output arch.drawit [--mode auto|files|dirs] [--depth 4] [--split]

# Analyze package dependencies
drawit deps ./packages --output deps.drawit

# Analyze Next.js routes
drawit routes ./app --output routes.drawit

# Generate ER diagram from Prisma schema
drawit schema ./prisma/schema.prisma --output er.drawit

# Merge multiple diagrams
drawit merge a.drawit b.drawit --output merged.drawit [--layout horizontal|vertical]
```

## Important Rules

1. **Nodes before edges**: Define all nodes before any edges that reference them
2. **Unique IDs**: Every element must have a unique `id` string
3. **Valid hex colors**: All colors must be hex codes (e.g., `#1976d2`)
4. **One JSON per line**: NDJSON format — no trailing commas, no multi-line JSON
5. **Metadata has no `type`**: The first line (metadata) must NOT have a `type` field
6. **Elements always have `type`**: Every element line must have `type: "node"` or `type: "edge"`
7. **Edge targets must exist**: `source` and `target` must reference valid node IDs
8. **Positions in pixels**: All x, y, width, height values are pixel coordinates
