package guardrails

import (
	"fmt"
	"net/url"
	"strings"
)

// defaultAllowlist is the set of allowed host patterns by default.
// Agents operating on localhost dev servers and preview deployments are the
// primary use case. Production domains are blocked unless explicitly added.
var defaultAllowlist = []string{
	"localhost",
	"127.0.0.1",
	"0.0.0.0",
	"*.local",
	"*.vercel.app",
	"*.ngrok.io",
	"*.ngrok-free.app",
	"*.preview.app",
}

// DomainGuard enforces the domain allowlist.
type DomainGuard struct {
	patterns []string
}

// NewDomainGuard creates a guard with the default allowlist plus any extras.
func NewDomainGuard(extra []string) *DomainGuard {
	patterns := make([]string, len(defaultAllowlist))
	copy(patterns, defaultAllowlist)
	patterns = append(patterns, extra...)
	return &DomainGuard{patterns: patterns}
}

// Check returns nil if the URL is allowed, or an error explaining the denial.
func (g *DomainGuard) Check(rawURL string) error {
	if rawURL == "about:blank" || rawURL == "" {
		return nil
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	host := u.Hostname()
	for _, pattern := range g.patterns {
		if matchHost(pattern, host) {
			return nil
		}
	}
	return fmt.Errorf(
		"domain %q is not in the allowlist.\n"+
			"Default allowed: localhost, *.vercel.app, *.ngrok.io\n"+
			"To add a domain, update HQ_BROWSER_ALLOWED_DOMAINS in your environment.",
		host,
	)
}

// Patterns returns the current allowlist.
func (g *DomainGuard) Patterns() []string {
	return g.patterns
}

func matchHost(pattern, host string) bool {
	if pattern == host {
		return true
	}
	if strings.HasPrefix(pattern, "*.") {
		suffix := pattern[1:] // ".example.com"
		return strings.HasSuffix(host, suffix) || host == pattern[2:]
	}
	return false
}
