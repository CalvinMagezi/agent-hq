BINARY     := bin/hq-browser
MODULE     := github.com/agent-hq/hq-browser
VERSION    := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS    := -ldflags "-X main.version=$(VERSION) -s -w"
GOFLAGS    := CGO_ENABLED=0

.PHONY: build build-all clean test lint deps run

## build: Build for the current platform
build:
	@mkdir -p bin
	$(GOFLAGS) go build $(LDFLAGS) -o $(BINARY) ./cmd/hq-browser

## build-all: Cross-compile for darwin/arm64, darwin/amd64, linux/amd64, linux/arm64
build-all:
	@mkdir -p bin
	GOOS=darwin  GOARCH=arm64 $(GOFLAGS) go build $(LDFLAGS) -o bin/hq-browser-darwin-arm64  ./cmd/hq-browser
	GOOS=darwin  GOARCH=amd64 $(GOFLAGS) go build $(LDFLAGS) -o bin/hq-browser-darwin-amd64  ./cmd/hq-browser
	GOOS=linux   GOARCH=amd64 $(GOFLAGS) go build $(LDFLAGS) -o bin/hq-browser-linux-amd64   ./cmd/hq-browser
	GOOS=linux   GOARCH=arm64 $(GOFLAGS) go build $(LDFLAGS) -o bin/hq-browser-linux-arm64   ./cmd/hq-browser
	@echo "Binaries in bin/:"
	@ls -lh bin/

## clean: Remove built binaries
clean:
	rm -rf bin/

## deps: Download dependencies
deps:
	go mod download
	go mod tidy

## test: Run all tests
test:
	go test ./... -v -timeout 60s

## lint: Run golangci-lint (install with: brew install golangci-lint)
lint:
	golangci-lint run ./...

## run: Build and run the server (requires VAULT_PATH env var)
run: build
	./$(BINARY) --vault "$(VAULT_PATH)" --port 19200

## run-headless: Build and run in headless mode
run-headless: build
	./$(BINARY) --vault "$(VAULT_PATH)" --port 19200 --headless

help:
	@grep -E '^## ' Makefile | sed 's/## /  /'
