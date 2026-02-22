# JSON Canvas Reference

Create and edit JSON Canvas files (.canvas) with nodes, edges, groups, and connections. Use when working with .canvas files, creating visual canvases, mind maps, flowcharts, or when the user mentions Canvas files in Obsidian.

## Overview

JSON Canvas is an open file format for infinite canvas data. Canvas files use the `.canvas` extension and contain valid JSON following the [JSON Canvas Spec 1.0](https://jsoncanvas.org/spec/1.0/).

## File Structure

```json
{
  "nodes": [],
  "edges": []
}
```

## Nodes

Four node types: `text`, `file`, `link`, `group`.

Nodes are ordered by z-index in the array (first = bottom, last = top).

### Generic Node Attributes

| Attribute | Required | Type | Description |
|-----------|----------|------|-------------|
| `id` | Yes | string | Unique 16-char hex identifier |
| `type` | Yes | string | `text`, `file`, `link`, or `group` |
| `x` | Yes | integer | X position in pixels |
| `y` | Yes | integer | Y position in pixels |
| `width` | Yes | integer | Width in pixels |
| `height` | Yes | integer | Height in pixels |
| `color` | No | canvasColor | Node color |

### Text Nodes

```json
{
  "id": "6f0ad84f44ce9c17",
  "type": "text",
  "x": 0,
  "y": 0,
  "width": 400,
  "height": 200,
  "text": "# Hello World\n\nThis is **Markdown** content."
}
```

**Important:** Newlines in JSON strings must be `\n`. Do NOT use `\\n`.

### File Nodes

```json
{
  "id": "a1b2c3d4e5f67890",
  "type": "file",
  "x": 500,
  "y": 0,
  "width": 400,
  "height": 300,
  "file": "Attachments/diagram.png"
}
```

Optional `subpath` for heading/block links: `"subpath": "#Implementation"`

### Link Nodes

```json
{
  "id": "c3d4e5f678901234",
  "type": "link",
  "x": 1000,
  "y": 0,
  "width": 400,
  "height": 200,
  "url": "https://obsidian.md"
}
```

### Group Nodes

```json
{
  "id": "d4e5f6789012345a",
  "type": "group",
  "x": -50,
  "y": -50,
  "width": 1000,
  "height": 600,
  "label": "Project Overview",
  "color": "4"
}
```

Optional: `background` (image path), `backgroundStyle` (`cover` | `ratio` | `repeat`)

## Edges

```json
{
  "id": "0123456789abcdef",
  "fromNode": "6f0ad84f44ce9c17",
  "fromSide": "right",
  "fromEnd": "none",
  "toNode": "b2c3d4e5f6789012",
  "toSide": "left",
  "toEnd": "arrow",
  "color": "1",
  "label": "leads to"
}
```

| Attribute | Required | Default | Description |
|-----------|----------|---------|-------------|
| `id` | Yes | - | Unique identifier |
| `fromNode` | Yes | - | Source node ID |
| `fromSide` | No | - | `top`, `right`, `bottom`, `left` |
| `fromEnd` | No | `none` | `none` or `arrow` |
| `toNode` | Yes | - | Target node ID |
| `toSide` | No | - | `top`, `right`, `bottom`, `left` |
| `toEnd` | No | `arrow` | `none` or `arrow` |
| `color` | No | - | Line color |
| `label` | No | - | Edge label text |

## Colors

Hex: `"#FF0000"` or Preset: `"1"` (Red), `"2"` (Orange), `"3"` (Yellow), `"4"` (Green), `"5"` (Cyan), `"6"` (Purple)

## ID Generation

16-character lowercase hex string: `"6f0ad84f44ce9c17"`

## Layout Guidelines

- Coordinates can be negative (canvas extends infinitely)
- `x` increases right, `y` increases down
- Position refers to top-left corner
- Small text: 200-300w x 80-150h
- Medium text: 300-450w x 150-300h
- Leave 20-50px padding inside groups
- Space nodes 50-100px apart

## Validation Rules

1. All `id` values must be unique across nodes and edges
2. `fromNode`/`toNode` must reference existing node IDs
3. Required fields must be present for each node type
4. `type` must be `text`, `file`, `link`, or `group`
5. Color presets: `"1"` through `"6"` or valid hex

## References

- [JSON Canvas Spec 1.0](https://jsoncanvas.org/spec/1.0/)
- [JSON Canvas GitHub](https://github.com/obsidianmd/jsoncanvas)
