// Package actions implements browser automation actions via CDP.
package actions

import (
	"context"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/agent-hq/hq-browser/internal/cdp"
	"github.com/agent-hq/hq-browser/internal/snapshot"
)

// Navigate navigates the browser to a URL and waits for load.
func Navigate(ctx context.Context, client *cdp.Client, url string) error {
	_, err := client.Call(ctx, "Page.navigate", map[string]any{"url": url})
	if err != nil {
		return fmt.Errorf("navigate to %s: %w", url, err)
	}
	// Wait briefly for the page to settle.
	time.Sleep(500 * time.Millisecond)
	return nil
}

// Click clicks an element identified by its CDP backend node ID.
func Click(ctx context.Context, client *cdp.Client, refs *snapshot.RefStore, ref string) error {
	nodeID, ok := refs.Resolve(ref)
	if !ok {
		return fmt.Errorf("unknown ref %q — run snapshot first", ref)
	}
	// Get the box model to find click coordinates.
	result, err := client.Call(ctx, "DOM.getBoxModel", map[string]any{
		"backendNodeId": nodeID,
	})
	if err != nil {
		return fmt.Errorf("get box model for %s: %w", ref, err)
	}
	model, ok := result["model"].(map[string]any)
	if !ok {
		return fmt.Errorf("no box model for %s", ref)
	}
	content, ok := model["content"].([]any)
	if !ok || len(content) < 4 {
		return fmt.Errorf("invalid box model content for %s", ref)
	}
	x := (toFloat(content[0]) + toFloat(content[4])) / 2
	y := (toFloat(content[1]) + toFloat(content[5])) / 2

	for _, typ := range []string{"mousePressed", "mouseReleased"} {
		if _, err := client.Call(ctx, "Input.dispatchMouseEvent", map[string]any{
			"type":       typ,
			"x":          x,
			"y":          y,
			"button":     "left",
			"clickCount": 1,
		}); err != nil {
			return fmt.Errorf("dispatch click event (%s): %w", typ, err)
		}
	}
	time.Sleep(200 * time.Millisecond)
	return nil
}

// Fill clears an input and types the given value into it.
func Fill(ctx context.Context, client *cdp.Client, refs *snapshot.RefStore, ref, value string) error {
	if err := focusByRef(ctx, client, refs, ref); err != nil {
		return err
	}
	// Select all and delete existing content.
	if err := Press(ctx, client, "ctrl+a"); err != nil {
		return err
	}
	return typeText(ctx, client, value)
}

// Type types text into the focused element without clearing it first.
func Type(ctx context.Context, client *cdp.Client, refs *snapshot.RefStore, ref, value string) error {
	if err := focusByRef(ctx, client, refs, ref); err != nil {
		return err
	}
	return typeText(ctx, client, value)
}

// Press dispatches a key event. Supports "Enter", "Tab", "Escape", "ctrl+a", etc.
func Press(ctx context.Context, client *cdp.Client, key string) error {
	key, modifiers := parseKey(key)
	for _, typ := range []string{"keyDown", "keyUp"} {
		if _, err := client.Call(ctx, "Input.dispatchKeyEvent", map[string]any{
			"type":      typ,
			"key":       key,
			"modifiers": modifiers,
		}); err != nil {
			return fmt.Errorf("press %s (%s): %w", key, typ, err)
		}
	}
	return nil
}

// Scroll scrolls the page in a given direction by the given pixel amount.
func Scroll(ctx context.Context, client *cdp.Client, direction string, amount int) error {
	var dx, dy float64
	switch direction {
	case "down":
		dy = float64(amount)
	case "up":
		dy = -float64(amount)
	case "right":
		dx = float64(amount)
	case "left":
		dx = -float64(amount)
	default:
		return fmt.Errorf("unknown scroll direction %q (use up/down/left/right)", direction)
	}
	_, err := client.Call(ctx, "Input.dispatchMouseEvent", map[string]any{
		"type":       "mouseWheel",
		"x":          640,
		"y":          400,
		"deltaX":     dx,
		"deltaY":     dy,
	})
	return err
}

// Screenshot captures a PNG screenshot and returns the raw bytes.
// If annotate is true, element refs are overlaid on the image (via JS injection).
func Screenshot(ctx context.Context, client *cdp.Client) ([]byte, error) {
	result, err := client.Call(ctx, "Page.captureScreenshot", map[string]any{
		"format":  "png",
		"quality": 90,
	})
	if err != nil {
		return nil, fmt.Errorf("capture screenshot: %w", err)
	}
	dataStr, ok := result["data"].(string)
	if !ok {
		return nil, fmt.Errorf("screenshot response missing data")
	}
	return base64.StdEncoding.DecodeString(dataStr)
}

// SetViewport resizes the browser viewport.
func SetViewport(ctx context.Context, client *cdp.Client, width, height int) error {
	_, err := client.Call(ctx, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width":             width,
		"height":            height,
		"deviceScaleFactor": 1,
		"mobile":            width <= 480,
	})
	return err
}

// Evaluate runs JavaScript in the page and returns the result.
func Evaluate(ctx context.Context, client *cdp.Client, script string) (any, error) {
	result, err := client.Call(ctx, "Runtime.evaluate", map[string]any{
		"expression":    script,
		"returnByValue": true,
	})
	if err != nil {
		return nil, err
	}
	if exc, ok := result["exceptionDetails"]; ok && exc != nil {
		return nil, fmt.Errorf("js exception: %v", exc)
	}
	if rv, ok := result["result"].(map[string]any); ok {
		return rv["value"], nil
	}
	return nil, nil
}

// GetURL returns the current page URL.
func GetURL(ctx context.Context, client *cdp.Client) (string, error) {
	v, err := Evaluate(ctx, client, "window.location.href")
	if err != nil {
		return "", err
	}
	if s, ok := v.(string); ok {
		return s, nil
	}
	return "", nil
}

// GetTitle returns the current page title.
func GetTitle(ctx context.Context, client *cdp.Client) (string, error) {
	v, err := Evaluate(ctx, client, "document.title")
	if err != nil {
		return "", err
	}
	if s, ok := v.(string); ok {
		return s, nil
	}
	return "", nil
}

// ── helpers ──────────────────────────────────────────────────────────────────

func focusByRef(ctx context.Context, client *cdp.Client, refs *snapshot.RefStore, ref string) error {
	nodeID, ok := refs.Resolve(ref)
	if !ok {
		return fmt.Errorf("unknown ref %q — run snapshot first", ref)
	}
	if _, err := client.Call(ctx, "DOM.focus", map[string]any{"backendNodeId": nodeID}); err != nil {
		return fmt.Errorf("focus %s: %w", ref, err)
	}
	return nil
}

func typeText(ctx context.Context, client *cdp.Client, text string) error {
	_, err := client.Call(ctx, "Input.insertText", map[string]any{"text": text})
	return err
}

func toFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	}
	return 0
}

// parseKey splits "ctrl+a" into key="a", modifiers=2 (CDP modifier bitmask).
func parseKey(key string) (string, int) {
	modifiers := 0
	k := key
	for {
		switch {
		case len(k) > 5 && k[:5] == "ctrl+":
			modifiers |= 2
			k = k[5:]
		case len(k) > 4 && k[:4] == "alt+":
			modifiers |= 1
			k = k[4:]
		case len(k) > 6 && k[:6] == "shift+":
			modifiers |= 8
			k = k[6:]
		case len(k) > 5 && k[:5] == "meta+":
			modifiers |= 4
			k = k[5:]
		default:
			return keyName(k), modifiers
		}
	}
}

func keyName(k string) string {
	// Normalize common key names to CDP key names.
	switch k {
	case "enter", "return":
		return "Enter"
	case "tab":
		return "Tab"
	case "escape", "esc":
		return "Escape"
	case "backspace":
		return "Backspace"
	case "delete", "del":
		return "Delete"
	case "arrowup", "up":
		return "ArrowUp"
	case "arrowdown", "down":
		return "ArrowDown"
	case "arrowleft", "left":
		return "ArrowLeft"
	case "arrowright", "right":
		return "ArrowRight"
	case "space":
		return " "
	default:
		return k
	}
}
