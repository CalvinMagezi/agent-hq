package snapshot

import (
	"sync"
)

// RefStore maps stable short refs (e0, e1, ...) to CDP backend DOM node IDs.
// Refs are session-scoped and reset on each snapshot call.
type RefStore struct {
	mu      sync.RWMutex
	refToID map[string]int
	idToRef map[int]string
	counter int
}

// NewRefStore creates an empty ref store.
func NewRefStore() *RefStore {
	return &RefStore{
		refToID: make(map[string]int),
		idToRef: make(map[int]string),
	}
}

// Reset clears all refs (called at the start of each snapshot).
func (r *RefStore) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.refToID = make(map[string]int)
	r.idToRef = make(map[int]string)
	r.counter = 0
}

// Assign returns an existing ref for backendNodeID or creates a new one.
func (r *RefStore) Assign(backendNodeID int) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ref, ok := r.idToRef[backendNodeID]; ok {
		return ref
	}
	ref := refName(r.counter)
	r.counter++
	r.refToID[ref] = backendNodeID
	r.idToRef[backendNodeID] = ref
	return ref
}

// Resolve returns the backend DOM node ID for a ref.
func (r *RefStore) Resolve(ref string) (int, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	id, ok := r.refToID[ref]
	return id, ok
}

// RefFor returns the ref string for a backend DOM node ID.
func (r *RefStore) RefFor(backendNodeID int) (string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ref, ok := r.idToRef[backendNodeID]
	return ref, ok
}

// AllRefs returns a copy of the ref->backendNodeID map.
func (r *RefStore) AllRefs() map[string]int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[string]int, len(r.refToID))
	for k, v := range r.refToID {
		out[k] = v
	}
	return out
}

func refName(n int) string {
	return "e" + itoa(n)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	buf := make([]byte, 0, 8)
	for n > 0 {
		buf = append([]byte{byte('0' + n%10)}, buf...)
		n /= 10
	}
	return string(buf)
}
