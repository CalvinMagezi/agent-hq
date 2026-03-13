package snapshot

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/agent-hq/hq-browser/internal/cdp"
)

// interactiveRoles are accessibility roles that agents can act on.
var interactiveRoles = map[string]bool{
	"button": true, "link": true, "textbox": true, "searchbox": true,
	"combobox": true, "listbox": true, "checkbox": true, "radio": true,
	"menuitem": true, "menuitemcheckbox": true, "menuitemradio": true,
	"option": true, "tab": true, "slider": true, "spinbutton": true,
	"switch": true, "treeitem": true, "gridcell": true,
}

// Result is the output of a snapshot operation.
type Result struct {
	Tree          string         // Human-readable accessibility tree text
	NodeCount     int            // Total nodes rendered
	InteractCount int            // Interactive nodes (with refs)
	Refs          map[string]int // ref -> backendNodeID
}

// Take extracts the accessibility tree from the current page and returns a
// text representation with stable refs. If interactiveOnly is true, only
// nodes agents can act on are included in the output.
func Take(ctx context.Context, client *cdp.Client, refs *RefStore, interactiveOnly bool) (*Result, error) {
	refs.Reset()

	result, err := client.Call(ctx, "Accessibility.getFullAXTree", map[string]any{})
	if err != nil {
		return nil, fmt.Errorf("get ax tree: %w", err)
	}

	nodesRaw, ok := result["nodes"]
	if !ok {
		return nil, fmt.Errorf("no nodes in AX tree response")
	}

	data, _ := json.Marshal(nodesRaw)
	var nodes []cdp.AXNode
	if err := json.Unmarshal(data, &nodes); err != nil {
		return nil, fmt.Errorf("parse ax nodes: %w", err)
	}

	// Build node index and child-to-parent map.
	nodeByID := make(map[string]*cdp.AXNode, len(nodes))
	childOf := make(map[string]string)
	for i := range nodes {
		nodeByID[nodes[i].NodeID] = &nodes[i]
		for _, child := range nodes[i].ChildIDs {
			childOf[child] = nodes[i].NodeID
		}
	}

	// Find root nodes (no parent).
	var roots []string
	for _, n := range nodes {
		if _, hasParent := childOf[n.NodeID]; !hasParent {
			roots = append(roots, n.NodeID)
		}
	}

	var sb strings.Builder
	total, interactive := 0, 0

	var walk func(nodeID string, depth int)
	walk = func(nodeID string, depth int) {
		n, ok := nodeByID[nodeID]
		if !ok {
			return
		}
		role := axStr(n.Role)
		name := axStr(n.Name)
		roleLower := strings.ToLower(role)
		isInteractive := interactiveRoles[roleLower]

		if !interactiveOnly || isInteractive {
			total++
			indent := strings.Repeat("  ", depth)
			line := indent + role
			if isInteractive && n.BackendDOMNodeID > 0 {
				interactive++
				ref := refs.Assign(n.BackendDOMNodeID)
				line += " [" + ref + "]"
			}
			if name != "" {
				line += " " + quoted(name)
			}
			if val := axStr(n.Value); val != "" {
				line += " = " + quoted(val)
			}
			sb.WriteString(line + "\n")
		}

		for _, childID := range n.ChildIDs {
			walk(childID, depth+1)
		}
	}

	for _, root := range roots {
		walk(root, 0)
	}

	return &Result{
		Tree:          sb.String(),
		NodeCount:     total,
		InteractCount: interactive,
		Refs:          refs.AllRefs(),
	}, nil
}

func axStr(v *cdp.AXValue) string {
	if v == nil {
		return ""
	}
	if s, ok := v.Value.(string); ok {
		return s
	}
	return ""
}

func quoted(s string) string {
	if len(s) > 80 {
		return `"` + s[:77] + `..."`
	}
	return `"` + s + `"`
}
