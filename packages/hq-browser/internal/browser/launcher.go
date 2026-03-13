package browser

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"time"
)

// chromePaths is the list of candidate Chrome binary paths per OS.
var chromePaths = map[string][]string{
	"darwin": {
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
	},
	"linux": {
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium-browser",
		"/usr/bin/chromium",
		"/snap/bin/chromium",
	},
	"windows": {
		`C:\Program Files\Google\Chrome\Application\chrome.exe`,
		`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
	},
}

// FindChrome returns the path to the first available Chrome binary.
func FindChrome() (string, error) {
	// Check CHROME_PATH env override first.
	if p := os.Getenv("CHROME_PATH"); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	paths, ok := chromePaths[runtime.GOOS]
	if !ok {
		return "", fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	// Fall back to PATH lookup.
	for _, name := range []string{"google-chrome", "google-chrome-stable", "chromium-browser", "chromium"} {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf(
		"Chrome not found. Install Google Chrome and ensure it is accessible.\n" +
			"Set CHROME_PATH env var to point to the Chrome binary if it's in a non-standard location.",
	)
}

// LaunchOptions configures how Chrome is launched.
type LaunchOptions struct {
	ChromePath  string
	ProfileDir  string
	DebugPort   int
	Headless    bool
	WindowWidth int
	WindowHeight int
}

// Launch starts a Chrome process and returns it.
func Launch(opts LaunchOptions) (*exec.Cmd, error) {
	chromePath := opts.ChromePath
	if chromePath == "" {
		var err error
		chromePath, err = FindChrome()
		if err != nil {
			return nil, err
		}
	}

	args := []string{
		fmt.Sprintf("--remote-debugging-port=%d", opts.DebugPort),
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--disable-client-side-phishing-detection",
		"--disable-default-apps",
		"--disable-extensions",
		"--disable-hang-monitor",
		"--disable-popup-blocking",
		"--disable-prompt-on-repost",
		"--disable-sync",
		"--disable-translate",
		"--metrics-recording-only",
		"--safebrowsing-disable-auto-update",
		"--password-store=basic",
		"--use-mock-keychain",
		"--disable-blink-features=AutomationControlled",
		"--disable-infobars",
	}

	if opts.ProfileDir != "" {
		args = append(args, "--user-data-dir="+opts.ProfileDir)
	}

	width := opts.WindowWidth
	if width == 0 {
		width = 1280
	}
	height := opts.WindowHeight
	if height == 0 {
		height = 800
	}
	args = append(args, fmt.Sprintf("--window-size=%d,%d", width, height))

	if opts.Headless {
		args = append(args, "--headless=new", "--disable-gpu")
	}

	// Open about:blank as initial page.
	args = append(args, "about:blank")

	cmd := exec.Command(chromePath, args...)
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("launch chrome: %w", err)
	}
	return cmd, nil
}

// WaitForDebugPort polls until Chrome's debugging endpoint is reachable.
func WaitForDebugPort(ctx context.Context, port int) error {
	url := fmt.Sprintf("http://127.0.0.1:%d/json/version", port)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		resp, err := http.Get(url) //nolint:gosec
		if err == nil {
			resp.Body.Close()
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("chrome debug port %d not ready after 15s", port)
}
