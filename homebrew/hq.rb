# Homebrew formula for the hq CLI
#
# To publish this as a tap:
#   1. Create a GitHub repo: CalvinMagezi/homebrew-agent-hq
#   2. Copy this file to Formula/hq.rb in that repo
#   3. Update the `url` and `sha256` fields for each release
#
# Users install with:
#   brew tap calvinmagezi/agent-hq
#   brew install hq
#
# Or in one line:
#   brew install calvinmagezi/agent-hq/hq

class Hq < Formula
  desc "Local-first AI agent hub — Claude, Gemini & Discord from one command"
  homepage "https://github.com/CalvinMagezi/agent-hq"
  url "https://github.com/CalvinMagezi/agent-hq/archive/refs/tags/v0.1.0.tar.gz"
  # Update sha256 after `brew fetch --build-from-source hq.rb` or via CI
  sha256 "273fe942b135ced609a16a71983a2a8c334557fbb67786f853dad76f5160e281"
  license "MIT"
  version "0.1.0"

  depends_on "bun"
  depends_on "git"

  def install
    # Make the entry script executable
    chmod 0755, "scripts/hq.ts"

    # Install the full repo into the Cellar so relative paths work
    libexec.install Dir["*"]

    # Create a thin wrapper that execs into the Cellar copy
    (bin/"hq").write <<~SH
      #!/bin/bash
      exec bun "#{libexec}/scripts/hq.ts" "$@"
    SH
    chmod 0755, bin/"hq"
  end

  def caveats
    <<~EOS
      Run the first-time setup to scaffold your vault and configure your environment:

        hq init

      For unattended/agent-driven install:

        hq init --non-interactive

      Add your API keys to:
        #{Dir.home}/agent-hq/apps/agent/.env.local
        #{Dir.home}/agent-hq/apps/discord-relay/.env.local
    EOS
  end

  test do
    output = shell_output("#{bin}/hq help")
    assert_match "Agent HQ CLI", output
  end
end
