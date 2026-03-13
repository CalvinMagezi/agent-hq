package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/agent-hq/hq-browser/internal/server"
)

var version = "0.1.0"

func main() {
	var (
		port     = flag.Int("port", 19200, "HTTP server port")
		bind     = flag.String("bind", "127.0.0.1", "Bind address (default: localhost only)")
		vault    = flag.String("vault", "", "Path to Agent-HQ vault directory (required)")
		headless = flag.Bool("headless", false, "Run Chrome in headless mode")
		domains  = flag.String("allow-domains", "", "Comma-separated extra allowed domains")
		showVer  = flag.Bool("version", false, "Print version and exit")
	)
	flag.Parse()

	if *showVer {
		fmt.Printf("hq-browser %s\n", version)
		os.Exit(0)
	}

	vaultPath := *vault
	if vaultPath == "" {
		vaultPath = os.Getenv("VAULT_PATH")
	}
	if vaultPath == "" {
		log.Fatal("--vault flag or VAULT_PATH env var is required")
	}

	// Resolve absolute path.
	abs, err := filepath.Abs(vaultPath)
	if err != nil {
		log.Fatalf("resolve vault path: %v", err)
	}
	vaultPath = abs

	// Profiles live inside the vault's internal area.
	profilesDir := filepath.Join(vaultPath, "_browser", "profiles")

	var extraDomains []string
	if *domains != "" {
		for _, d := range strings.Split(*domains, ",") {
			if d = strings.TrimSpace(d); d != "" {
				extraDomains = append(extraDomains, d)
			}
		}
	}
	// Also read from env.
	if env := os.Getenv("HQ_BROWSER_ALLOWED_DOMAINS"); env != "" {
		for _, d := range strings.Split(env, ",") {
			if d = strings.TrimSpace(d); d != "" {
				extraDomains = append(extraDomains, d)
			}
		}
	}

	cfg := server.Config{
		Port:         *port,
		BindAddr:     *bind,
		VaultPath:    vaultPath,
		ProfilesDir:  profilesDir,
		Headless:     *headless,
		ExtraDomains: extraDomains,
	}

	srv := server.New(cfg)
	if err := srv.Start(); err != nil {
		log.Fatalf("server: %v", err)
	}
}
