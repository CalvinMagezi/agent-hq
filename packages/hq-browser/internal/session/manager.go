package session

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"time"

	"github.com/agent-hq/hq-browser/internal/browser"
)

// Instance is re-exported so callers only need to import session.
type Instance = browser.Instance

const (
	baseDebugPort = 19300 // Chrome debug ports start here, one per session
	maxSessions   = 20
)

// Manager owns all browser sessions.
type Manager struct {
	mu           sync.RWMutex
	sessions     map[string]*browser.Instance
	profilesRoot string
	vaultPath    string
	headless     bool
	nextPort     int
}

// NewManager creates a session manager.
func NewManager(profilesRoot, vaultPath string, headless bool) *Manager {
	return &Manager{
		sessions:     make(map[string]*browser.Instance),
		profilesRoot: profilesRoot,
		vaultPath:    vaultPath,
		headless:     headless,
		nextPort:     baseDebugPort,
	}
}

// Create starts a new browser session and returns the instance.
func (m *Manager) Create(ctx context.Context, jobID string) (*browser.Instance, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(m.sessions) >= maxSessions {
		return nil, fmt.Errorf("max sessions (%d) reached", maxSessions)
	}

	id := newSessionID()
	port := m.nextPort
	m.nextPort++

	inst, err := browser.NewInstance(ctx, id, jobID, m.profilesRoot, port, m.headless)
	if err != nil {
		return nil, fmt.Errorf("create session %s: %w", id, err)
	}

	m.sessions[id] = inst
	return inst, nil
}

// Get returns a session by ID.
func (m *Manager) Get(id string) (*browser.Instance, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	inst, ok := m.sessions[id]
	if !ok {
		return nil, fmt.Errorf("session %q not found", id)
	}
	return inst, nil
}

// Destroy kills a session and removes it from the registry.
func (m *Manager) Destroy(id string) error {
	m.mu.Lock()
	inst, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("session %q not found", id)
	}
	delete(m.sessions, id)
	m.mu.Unlock()
	return inst.Kill()
}

// DestroyByJob kills all sessions associated with a job ID.
func (m *Manager) DestroyByJob(jobID string) {
	m.mu.Lock()
	var toKill []*browser.Instance
	var toDelete []string
	for id, inst := range m.sessions {
		if inst.JobID == jobID {
			toKill = append(toKill, inst)
			toDelete = append(toDelete, id)
		}
	}
	for _, id := range toDelete {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	for _, inst := range toKill {
		_ = inst.Kill()
	}
}

// List returns info for all active sessions.
func (m *Manager) List() []map[string]any {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]map[string]any, 0, len(m.sessions))
	for _, inst := range m.sessions {
		out = append(out, inst.Info())
	}
	return out
}

// Count returns the number of active sessions.
func (m *Manager) Count() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sessions)
}

func newSessionID() string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	rng := rand.New(rand.NewSource(time.Now().UnixNano())) //nolint:gosec
	b := make([]byte, 8)
	for i := range b {
		b[i] = chars[rng.Intn(len(chars))]
	}
	return "sess-" + string(b)
}
