package cdp

// Message is a raw CDP protocol message.
type Message struct {
	ID     int            `json:"id,omitempty"`
	Method string         `json:"method,omitempty"`
	Params map[string]any `json:"params,omitempty"`
	Result map[string]any `json:"result,omitempty"`
	Error  *RPCError      `json:"error,omitempty"`
}

// RPCError is a CDP protocol error.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Event is an unsolicited CDP event.
type Event struct {
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

// VersionInfo is returned by /json/version.
type VersionInfo struct {
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	Browser              string `json:"Browser"`
	ProtocolVersion      string `json:"Protocol-Version"`
}

// TargetInfo describes a CDP target (tab).
type TargetInfo struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	URL   string `json:"url"`
	Title string `json:"title"`
	WSURL string `json:"webSocketDebuggerUrl"`
}

// AXNode is an accessibility tree node from CDP.
type AXNode struct {
	NodeID          string   `json:"nodeId"`
	IgnoredReasons  []any    `json:"ignoredReasons,omitempty"`
	Role            *AXValue `json:"role,omitempty"`
	Name            *AXValue `json:"name,omitempty"`
	Description     *AXValue `json:"description,omitempty"`
	Value           *AXValue `json:"value,omitempty"`
	Properties      []any    `json:"properties,omitempty"`
	ChildIDs        []string `json:"childIds,omitempty"`
	BackendDOMNodeID int     `json:"backendDOMNodeId,omitempty"`
}

// AXValue is an accessibility property value.
type AXValue struct {
	Type  string `json:"type"`
	Value any    `json:"value,omitempty"`
}
