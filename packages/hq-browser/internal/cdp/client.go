package cdp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	callTimeout    = 30 * time.Second
	connectTimeout = 10 * time.Second
)

// Client is a CDP WebSocket client for a single browser target.
type Client struct {
	conn     *websocket.Conn
	mu       sync.Mutex
	counter  atomic.Int64
	pending  map[int64]chan *Message
	pendingM sync.Mutex
	events   chan *Event
	done     chan struct{}
}

// Dial connects to a CDP target WebSocket URL.
func Dial(ctx context.Context, wsURL string) (*Client, error) {
	dialer := websocket.Dialer{HandshakeTimeout: connectTimeout}
	conn, _, err := dialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("cdp dial %s: %w", wsURL, err)
	}
	c := &Client{
		conn:    conn,
		pending: make(map[int64]chan *Message),
		events:  make(chan *Event, 64),
		done:    make(chan struct{}),
	}
	go c.readLoop()
	return c, nil
}

// Call sends a CDP method and waits for the response.
func (c *Client) Call(ctx context.Context, method string, params map[string]any) (map[string]any, error) {
	id := c.counter.Add(1)
	ch := make(chan *Message, 1)

	c.pendingM.Lock()
	c.pending[id] = ch
	c.pendingM.Unlock()

	msg := Message{ID: int(id), Method: method, Params: params}
	data, err := json.Marshal(msg)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	err = c.conn.WriteMessage(websocket.TextMessage, data)
	c.mu.Unlock()
	if err != nil {
		c.pendingM.Lock()
		delete(c.pending, id)
		c.pendingM.Unlock()
		return nil, fmt.Errorf("cdp write: %w", err)
	}

	timeout := time.After(callTimeout)
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timeout:
		return nil, fmt.Errorf("cdp call %s timed out", method)
	case resp := <-ch:
		if resp.Error != nil {
			return nil, fmt.Errorf("cdp error %d: %s", resp.Error.Code, resp.Error.Message)
		}
		return resp.Result, nil
	}
}

// Events returns the channel for unsolicited CDP events.
func (c *Client) Events() <-chan *Event {
	return c.events
}

// Close closes the WebSocket connection.
func (c *Client) Close() error {
	select {
	case <-c.done:
	default:
		close(c.done)
	}
	return c.conn.Close()
}

func (c *Client) readLoop() {
	defer func() {
		select {
		case <-c.done:
		default:
			close(c.done)
		}
	}()
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if msg.ID > 0 {
			c.pendingM.Lock()
			ch, ok := c.pending[int64(msg.ID)]
			if ok {
				delete(c.pending, int64(msg.ID))
			}
			c.pendingM.Unlock()
			if ok {
				ch <- &msg
			}
		} else if msg.Method != "" {
			select {
			case c.events <- &Event{Method: msg.Method, Params: msg.Params}:
			default:
			}
		}
	}
}

// FetchTargets fetches all targets from the Chrome debugging endpoint.
func FetchTargets(debugPort int) ([]TargetInfo, error) {
	url := fmt.Sprintf("http://127.0.0.1:%d/json/list", debugPort)
	resp, err := http.Get(url) //nolint:gosec
	if err != nil {
		return nil, fmt.Errorf("fetch targets: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var targets []TargetInfo
	if err := json.Unmarshal(body, &targets); err != nil {
		return nil, err
	}
	return targets, nil
}

// FetchVersion fetches the Chrome version info.
func FetchVersion(debugPort int) (*VersionInfo, error) {
	url := fmt.Sprintf("http://127.0.0.1:%d/json/version", debugPort)
	resp, err := http.Get(url) //nolint:gosec
	if err != nil {
		return nil, fmt.Errorf("fetch version: %w", err)
	}
	defer resp.Body.Close()
	var info VersionInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, err
	}
	return &info, nil
}
