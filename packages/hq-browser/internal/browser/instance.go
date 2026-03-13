package browser

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/agent-hq/hq-browser/internal/cdp"
)

// Instance represents a running Chrome process with an active CDP connection.
type Instance struct {
	ID         string
	JobID      string
	DebugPort  int
	ProfileDir string
	cmd        *exec.Cmd
	Client     *cdp.Client
	TargetID   string
	SessionID  string
	StartedAt  time.Time
	CurrentURL string

	ConsoleMu   sync.Mutex
	ConsoleLogs []ConsoleEntry
	NetworkMu   sync.Mutex
	NetworkLogs []NetworkEntry
}

// NewInstance launches Chrome and establishes a CDP connection.
func NewInstance(ctx context.Context, id, jobID, profilesRoot string, debugPort int, headless bool) (*Instance, error) {
	profileDir := filepath.Join(profilesRoot, id)
	if err := os.MkdirAll(profileDir, 0755); err != nil {
		return nil, fmt.Errorf("create profile dir: %w", err)
	}

	cmd, err := Launch(LaunchOptions{
		ProfileDir: profileDir,
		DebugPort:  debugPort,
		Headless:   headless,
	})
	if err != nil {
		return nil, err
	}

	inst := &Instance{
		ID:         id,
		JobID:      jobID,
		DebugPort:  debugPort,
		ProfileDir: profileDir,
		cmd:        cmd,
		StartedAt:  time.Now(),
		CurrentURL: "about:blank",
	}

	if err := WaitForDebugPort(ctx, debugPort); err != nil {
		_ = cmd.Process.Kill()
		return nil, err
	}

	// Get the first available page target.
	targets, err := cdp.FetchTargets(debugPort)
	if err != nil {
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("fetch targets: %w", err)
	}

	var targetWS string
	var targetID string
	for _, t := range targets {
		if t.Type == "page" {
			targetWS = t.WSURL
			targetID = t.ID
			break
		}
	}
	if targetWS == "" {
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("no page target found")
	}

	client, err := cdp.Dial(ctx, targetWS)
	if err != nil {
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("dial cdp: %w", err)
	}

	// Enable domains we'll use.
	for _, domain := range []string{"Page", "Runtime", "Accessibility", "DOM", "Network", "Console"} {
		if _, err := client.Call(ctx, domain+".enable", nil); err != nil {
			_ = client.Close()
			_ = cmd.Process.Kill()
			return nil, fmt.Errorf("enable %s domain: %w", domain, err)
		}
	}

	inst.Client = client
	inst.TargetID = targetID
	return inst, nil
}

// Kill terminates the Chrome process and cleans up.
func (inst *Instance) Kill() error {
	if inst.Client != nil {
		_ = inst.Client.Close()
	}
	if inst.cmd != nil && inst.cmd.Process != nil {
		_ = inst.cmd.Process.Kill()
		_ = inst.cmd.Wait()
	}
	return nil
}

// Info returns a summary of the instance state.
func (inst *Instance) Info() map[string]any {
	return map[string]any{
		"id":         inst.ID,
		"jobId":      inst.JobID,
		"debugPort":  inst.DebugPort,
		"currentUrl": inst.CurrentURL,
		"startedAt":  inst.StartedAt.UTC().Format(time.RFC3339),
	}
}

type ConsoleEntry struct {
	Level  string `json:"level"` // log|warning|error|info|debug
	Text   string `json:"text"`
	Source string `json:"source"`
	Time   string `json:"time"`
}

type NetworkEntry struct {
	Type      string `json:"type"` // request|response
	RequestID string `json:"requestId"`
	URL       string `json:"url"`
	Method    string `json:"method"`
	Status    int    `json:"status"`
	MimeType  string `json:"mimeType"`
	Time      string `json:"time"`
}

func (inst *Instance) AppendConsole(entry ConsoleEntry) {
	inst.ConsoleMu.Lock()
	defer inst.ConsoleMu.Unlock()
	inst.ConsoleLogs = append(inst.ConsoleLogs, entry)
	if len(inst.ConsoleLogs) > 100 {
		inst.ConsoleLogs = inst.ConsoleLogs[1:]
	}
}

func (inst *Instance) DrainConsole() []ConsoleEntry {
	inst.ConsoleMu.Lock()
	defer inst.ConsoleMu.Unlock()
	logs := inst.ConsoleLogs
	inst.ConsoleLogs = nil
	return logs
}

func (inst *Instance) AppendNetwork(entry NetworkEntry) {
	inst.NetworkMu.Lock()
	defer inst.NetworkMu.Unlock()
	inst.NetworkLogs = append(inst.NetworkLogs, entry)
	if len(inst.NetworkLogs) > 100 {
		inst.NetworkLogs = inst.NetworkLogs[1:]
	}
}

func (inst *Instance) DrainNetwork() []NetworkEntry {
	inst.NetworkMu.Lock()
	defer inst.NetworkMu.Unlock()
	logs := inst.NetworkLogs
	inst.NetworkLogs = nil
	return logs
}
