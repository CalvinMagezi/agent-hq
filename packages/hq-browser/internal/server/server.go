package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/agent-hq/hq-browser/internal/actions"
	"github.com/agent-hq/hq-browser/internal/browser"
	"github.com/agent-hq/hq-browser/internal/guardrails"
	"github.com/agent-hq/hq-browser/internal/session"
	"github.com/agent-hq/hq-browser/internal/snapshot"
	"github.com/agent-hq/hq-browser/internal/vault"
)

// Config holds server configuration.
type Config struct {
	Port         int
	BindAddr     string
	VaultPath    string
	ProfilesDir  string
	Headless     bool
	ExtraDomains []string
}

// Server is the hq-browser HTTP server.
type Server struct {
	cfg   Config
	mgr   *session.Manager
	vw    *vault.Writer
	guard *guardrails.DomainGuard
	refs  map[string]*snapshot.RefStore // sessionID -> RefStore
	mux   *http.ServeMux
}

// New creates a new Server.
func New(cfg Config) *Server {
	s := &Server{
		cfg:   cfg,
		mgr:   session.NewManager(cfg.ProfilesDir, cfg.VaultPath, cfg.Headless),
		vw:    vault.NewWriter(cfg.VaultPath),
		guard: guardrails.NewDomainGuard(cfg.ExtraDomains),
		refs:  make(map[string]*snapshot.RefStore),
		mux:   http.NewServeMux(),
	}
	s.routes()
	return s
}

// Start begins listening.
func (s *Server) Start() error {
	addr := fmt.Sprintf("%s:%d", s.cfg.BindAddr, s.cfg.Port)
	log.Printf("hq-browser listening on http://%s", addr)
	log.Printf("vault: %s", s.cfg.VaultPath)
	log.Printf("headless: %v", s.cfg.Headless)
	return http.ListenAndServe(addr, s.mux) //nolint:gosec
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /health", s.handleHealth)
	s.mux.HandleFunc("GET /metrics", s.handleMetrics)

	s.mux.HandleFunc("POST /sessions", s.handleSessionCreate)
	s.mux.HandleFunc("GET /sessions", s.handleSessionList)
	s.mux.HandleFunc("GET /sessions/{id}", s.handleSessionGet)
	s.mux.HandleFunc("DELETE /sessions/{id}", s.handleSessionDelete)

	s.mux.HandleFunc("POST /sessions/{id}/navigate", s.handleNavigate)
	s.mux.HandleFunc("GET /sessions/{id}/snapshot", s.handleSnapshot)
	s.mux.HandleFunc("GET /sessions/{id}/url", s.handleGetURL)
	s.mux.HandleFunc("GET /sessions/{id}/title", s.handleGetTitle)

	s.mux.HandleFunc("POST /sessions/{id}/click", s.handleClick)
	s.mux.HandleFunc("POST /sessions/{id}/fill", s.handleFill)
	s.mux.HandleFunc("POST /sessions/{id}/type", s.handleType)
	s.mux.HandleFunc("POST /sessions/{id}/press", s.handlePress)
	s.mux.HandleFunc("POST /sessions/{id}/scroll", s.handleScroll)
	s.mux.HandleFunc("POST /sessions/{id}/evaluate", s.handleEvaluate)
	s.mux.HandleFunc("POST /sessions/{id}/viewport", s.handleSetViewport)
	s.mux.HandleFunc("POST /sessions/{id}/screenshot", s.handleScreenshot)
	s.mux.HandleFunc("GET /sessions/{id}/console", s.handleConsole)
	s.mux.HandleFunc("GET /sessions/{id}/network", s.handleNetworkLog)
	s.mux.HandleFunc("POST /sessions/{id}/wait", s.handleWait)
	s.mux.HandleFunc("POST /sessions/{id}/select", s.handleSelect)
}

// ── handlers ──────────────────────────────────────────────────────────────────

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":   "ok",
		"sessions": s.mgr.Count(),
		"time":     time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"activeSessions": s.mgr.Count(),
		"vaultPath":      s.cfg.VaultPath,
		"headless":       s.cfg.Headless,
		"allowedDomains": s.guard.Patterns(),
	})
}

func (s *Server) handleSessionCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		JobID string `json:"jobId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	inst, err := s.mgr.Create(ctx, body.JobID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create session: "+err.Error())
		return
	}

	s.refs[inst.ID] = snapshot.NewRefStore()
	go s.drainEvents(inst)
	_ = s.vw.WriteSession(inst.ID, inst.JobID, inst.CurrentURL)

	writeJSON(w, http.StatusCreated, map[string]any{
		"sessionId": inst.ID,
		"jobId":     inst.JobID,
		"debugPort": inst.DebugPort,
	})
}

func (s *Server) handleSessionList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"sessions": s.mgr.List()})
}

func (s *Server) handleSessionGet(w http.ResponseWriter, r *http.Request) {
	inst, err := s.getSession(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, inst.Info())
}

func (s *Server) handleSessionDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.mgr.Destroy(id); err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	delete(s.refs, id)
	_ = s.vw.RemoveSession(id)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

func (s *Server) handleNavigate(w http.ResponseWriter, r *http.Request) {
	inst, err := s.getSession(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.URL == "" {
		writeError(w, http.StatusBadRequest, "body must include {url}")
		return
	}
	if err := s.guard.Check(body.URL); err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	if err := actions.Navigate(ctx, inst.Client, body.URL); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	inst.CurrentURL = body.URL
	_ = s.vw.WriteSession(inst.ID, inst.JobID, inst.CurrentURL)
	writeJSON(w, http.StatusOK, map[string]any{"url": body.URL})
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	inst, err := s.getSession(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	interactiveOnly := r.URL.Query().Get("i") == "1" || r.URL.Query().Get("interactive") == "true"

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	refs := s.refStore(inst.ID)
	result, err := snapshot.Take(ctx, inst.Client, refs, interactiveOnly)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tree":          result.Tree,
		"nodeCount":     result.NodeCount,
		"interactCount": result.InteractCount,
	})
}

func (s *Server) handleGetURL(w http.ResponseWriter, r *http.Request) {
	inst, err := s.getSession(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	u, err := actions.GetURL(ctx, inst.Client)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": u})
}

func (s *Server) handleGetTitle(w http.ResponseWriter, r *http.Request) {
	inst, err := s.getSession(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	title, err := actions.GetTitle(ctx, inst.Client)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"title": title})
}

func (s *Server) handleClick(w http.ResponseWriter, r *http.Request) {
	inst, refs, err := s.getSessionAndRefs(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	var body struct {
		Ref string `json:"ref"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Ref == "" {
		writeError(w, http.StatusBadRequest, "body must include {ref}")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := actions.Click(ctx, inst.Client, refs, body.Ref); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"clicked": body.Ref})
}

func (s *Server) handleFill(w http.ResponseWriter, r *http.Request) {
	inst, refs, err := s.getSessionAndRefs(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	var body struct {
		Ref   string `json:"ref"`
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Ref == "" {
		writeError(w, http.StatusBadRequest, "body must include {ref, value}")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := actions.Fill(ctx, inst.Client, refs, body.Ref, body.Value); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"filled": body.Ref})
}

func (s *Server) handleType(w http.ResponseWriter, r *http.Request) {
	inst, refs, err := s.getSessionAndRefs(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	var body struct {
		Ref   string `json:"ref"`
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Ref == "" {
		writeError(w, http.StatusBadRequest, "body must include {ref, value}")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := actions.Type(ctx, inst.Client, refs, body.Ref, body.Value); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"typed": body.Ref})
}

func (s *Server) handlePress(w http.ResponseWriter, r *http.Request) {
	inst, err := s.getSession(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	var body struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Key == "" {
		writeError(w, http.StatusBadRequest, "body must include {key}")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := actions.Press(ctx, inst.Client, body.Key); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"pressed": body.Key})
}

func (s *Server) handleScroll(w http.ResponseWriter, r *http.Request) {
	inst, err := s.getSession(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	var body struct {
		Direction string `json:"direction"`
		Amount    int    `json:"amount"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.Amount == 0 {
		body.Amount = 300
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := actions.Scroll(ctx, inst.Client, body.Direction, body.Amount); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scrolled": body.Direction, "amount": body.Amount})
}

func (s *Server) handleEvaluate(w http.ResponseWriter, r *http.Request) {
	inst, err := s.getSession(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	var body struct {
		Script string `json:"script"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Script == "" {
		writeError(w, http.StatusBadRequest, "body must include {script}")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	result, err := actions.Evaluate(ctx, inst.Client, body.Script)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": result})
}

func (s *Server) handleSetViewport(w http.ResponseWriter, r *http.Request) {
	inst, err := s.getSession(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	var body struct {
		Width  int `json:"width"`
		Height int `json:"height"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Width == 0 {
		writeError(w, http.StatusBadRequest, "body must include {width, height}")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := actions.SetViewport(ctx, inst.Client, body.Width, body.Height); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"width": body.Width, "height": body.Height})
}

func (s *Server) handleScreenshot(w http.ResponseWriter, r *http.Request) {
	inst, err := s.getSession(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	var body struct {
		Label string `json:"label"`
		JobID string `json:"jobId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	jobID := body.JobID
	if jobID == "" {
		jobID = inst.JobID
	}
	if jobID == "" {
		jobID = "unknown"
	}
	label := body.Label
	if label == "" {
		label = "screenshot"
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	data, err := actions.Screenshot(ctx, inst.Client)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	path, err := s.vw.WriteScreenshot(jobID, label, data)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "save screenshot: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path":     path,
		"fullPath": fmt.Sprintf("%s/%s", strings.TrimRight(s.cfg.VaultPath, "/"), path),
		"bytes":    len(data),
	})
}

func (s *Server) handleConsole(w http.ResponseWriter, r *http.Request) {
	inst, err := s.getSession(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	logs := inst.DrainConsole()
	writeJSON(w, http.StatusOK, map[string]any{"logs": logs, "count": len(logs)})
}

func (s *Server) handleNetworkLog(w http.ResponseWriter, r *http.Request) {
	inst, err := s.getSession(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	filter := r.URL.Query().Get("url")
	all := inst.DrainNetwork()
	var filtered []browser.NetworkEntry
	for _, e := range all {
		if filter == "" || strings.Contains(strings.ToLower(e.URL), strings.ToLower(filter)) {
			filtered = append(filtered, e)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": filtered, "count": len(filtered)})
}

func (s *Server) handleWait(w http.ResponseWriter, r *http.Request) {
	inst, refs, err := s.getSessionAndRefs(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	var body struct {
		Ref string `json:"ref"`
		URL string `json:"url"`
		MS  int    `json:"ms"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.MS == 0 {
		body.MS = 5000
	}

	start := time.Now()
	timeout := time.Duration(body.MS) * time.Millisecond
	for time.Since(start) < timeout {
		if body.URL != "" {
			u, _ := actions.GetURL(r.Context(), inst.Client)
			if strings.HasPrefix(u, body.URL) {
				writeJSON(w, http.StatusOK, map[string]any{"matched": "url"})
				return
			}
		}
			if _, ok := refs.Resolve(body.Ref); ok {
				writeJSON(w, http.StatusOK, map[string]any{"matched": "ref"})
				return
			}
			// Re-snapshot to see if it appeared
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			_, _ = snapshot.Take(ctx, inst.Client, refs, false)
			cancel()
			if _, ok := refs.Resolve(body.Ref); ok {
				writeJSON(w, http.StatusOK, map[string]any{"matched": "ref"})
				return
			}
		time.Sleep(200 * time.Millisecond)
	}
	writeError(w, http.StatusRequestTimeout, "condition not met within timeout")
}

func (s *Server) handleSelect(w http.ResponseWriter, r *http.Request) {
	inst, refs, err := s.getSessionAndRefs(r)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	var body struct {
		Ref   string `json:"ref"`
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Ref == "" {
		writeError(w, http.StatusBadRequest, "body must include {ref, value}")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// Logic: resolve ref -> node -> evaluate script to set .value
	nodeID, ok := refs.Resolve(body.Ref)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid ref: "+body.Ref)
		return
	}

	script := `function(v) { 
		this.value = v; 
		this.dispatchEvent(new Event('change',{bubbles:true})); 
		this.dispatchEvent(new Event('input',{bubbles:true})); 
	}`
	
	// Complex implementation using Runtime.callFunctionOn with resolved node
	res, err := inst.Client.Call(ctx, "DOM.resolveNode", map[string]any{"backendNodeId": nodeID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve node: "+err.Error())
		return
	}
	obj, ok := res["object"].(map[string]any)
	if !ok {
		writeError(w, http.StatusInternalServerError, "no object in resolveNode")
		return
	}
	objID := obj["objectId"].(string)

	_, err = inst.Client.Call(ctx, "Runtime.callFunctionOn", map[string]any{
		"objectId": objID,
		"functionDeclaration": script,
		"arguments": []any{map[string]any{"value": body.Value}},
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "select action: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"selected": body.Ref, "value": body.Value})
}

func (s *Server) drainEvents(inst *browser.Instance) {
	for evt := range inst.Client.Events() {
		switch evt.Method {
		case "Console.messageAdded":
			if msg, ok := evt.Params["message"].(map[string]any); ok {
				inst.AppendConsole(browser.ConsoleEntry{
					Level:  strOrEmpty(msg["level"]),
					Text:   strOrEmpty(msg["text"]),
					Source: strOrEmpty(msg["source"]),
					Time:   time.Now().UTC().Format(time.RFC3339),
				})
			}
		case "Network.requestWillBeSent":
			entry := browser.NetworkEntry{Type: "request", Time: time.Now().UTC().Format(time.RFC3339)}
			entry.RequestID = strOrEmpty(evt.Params["requestId"])
			if req, ok := evt.Params["request"].(map[string]any); ok {
				entry.URL = strOrEmpty(req["url"])
				entry.Method = strOrEmpty(req["method"])
			}
			inst.AppendNetwork(entry)
		case "Network.responseReceived":
			entry := browser.NetworkEntry{Type: "response", Time: time.Now().UTC().Format(time.RFC3339)}
			entry.RequestID = strOrEmpty(evt.Params["requestId"])
			if resp, ok := evt.Params["response"].(map[string]any); ok {
				entry.URL = strOrEmpty(resp["url"])
				if sc, ok := resp["status"].(float64); ok {
					entry.Status = int(sc)
				}
				entry.MimeType = strOrEmpty(resp["mimeType"])
			}
			inst.AppendNetwork(entry)
		}
	}
}

func strOrEmpty(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// ── helpers ───────────────────────────────────────────────────────────────────

func (s *Server) getSession(r *http.Request) (*browser.Instance, error) {
	return s.mgr.Get(r.PathValue("id"))
}

func (s *Server) getSessionAndRefs(r *http.Request) (*browser.Instance, *snapshot.RefStore, error) {
	inst, err := s.getSession(r)
	if err != nil {
		return nil, nil, err
	}
	return inst, s.refStore(inst.ID), nil
}

func (s *Server) refStore(sessionID string) *snapshot.RefStore {
	if refs, ok := s.refs[sessionID]; ok {
		return refs
	}
	refs := snapshot.NewRefStore()
	s.refs[sessionID] = refs
	return refs
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}
