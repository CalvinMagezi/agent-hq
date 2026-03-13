package vault

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Writer writes browser artifacts into the Agent-HQ vault.
type Writer struct {
	vaultPath string
}

// NewWriter creates a vault writer.
func NewWriter(vaultPath string) *Writer {
	return &Writer{vaultPath: vaultPath}
}

// WriteScreenshot saves screenshot bytes to the vault and returns the vault-relative path.
func (w *Writer) WriteScreenshot(jobID, label string, data []byte) (string, error) {
	dir := filepath.Join(w.vaultPath, "_browser", "screenshots", jobID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("create screenshot dir: %w", err)
	}
	ts := time.Now().Unix()
	filename := fmt.Sprintf("%d-%s.png", ts, sanitizeLabel(label))
	fullPath := filepath.Join(dir, filename)
	if err := os.WriteFile(fullPath, data, 0644); err != nil {
		return "", fmt.Errorf("write screenshot: %w", err)
	}
	// Return vault-relative path.
	rel := filepath.Join("_browser", "screenshots", jobID, filename)
	return rel, nil
}

// WritePDF saves PDF bytes to the vault and returns the vault-relative path.
func (w *Writer) WritePDF(jobID, label string, data []byte) (string, error) {
	dir := filepath.Join(w.vaultPath, "_browser", "pdfs", jobID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("create pdf dir: %w", err)
	}
	ts := time.Now().Unix()
	filename := fmt.Sprintf("%d-%s.pdf", ts, sanitizeLabel(label))
	fullPath := filepath.Join(dir, filename)
	if err := os.WriteFile(fullPath, data, 0644); err != nil {
		return "", fmt.Errorf("write pdf: %w", err)
	}
	rel := filepath.Join("_browser", "pdfs", jobID, filename)
	return rel, nil
}

// WriteSession writes session metadata to the vault.
func (w *Writer) WriteSession(sessionID, jobID, currentURL string) error {
	dir := filepath.Join(w.vaultPath, "_browser", "sessions")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	meta := map[string]string{
		"sessionId":  sessionID,
		"jobId":      jobID,
		"currentUrl": currentURL,
		"updatedAt":  time.Now().UTC().Format(time.RFC3339),
	}
	data, _ := json.MarshalIndent(meta, "", "  ")
	return os.WriteFile(filepath.Join(dir, sessionID+".json"), data, 0644)
}

// RemoveSession removes session metadata from the vault.
func (w *Writer) RemoveSession(sessionID string) error {
	path := filepath.Join(w.vaultPath, "_browser", "sessions", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func sanitizeLabel(s string) string {
	out := make([]byte, 0, len(s))
	for _, c := range []byte(s) {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' {
			out = append(out, c)
		} else {
			out = append(out, '-')
		}
	}
	if len(out) == 0 {
		return "screenshot"
	}
	return string(out)
}
