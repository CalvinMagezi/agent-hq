#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# SBLU GGUF Conversion & Ollama Registration
#
# Converts a LoRA adapter (from train.sh) into a GGUF model and registers it
# in Ollama as sblu-<name>:v1 and sblu-<name>:baseline (for rollback).
#
# Usage:
#   bash scripts/sblu/convert.sh --sblu cartographer --adapter /tmp/sblu-cartographer-adapter
#
# Options:
#   --sblu <name>         SBLU name
#   --adapter <path>      Path to mlx-lm LoRA adapter directory
#   --base <hf-id>        HuggingFace model ID used for training
#   --quant <type>        Quantization (default: Q4_K_M)
#   --version <v>         Model version tag (default: v1)
#   --vault <path>        Vault path (to update SBLU-REGISTRY.md)
#   --dry-run             Print steps without executing
#
# Prerequisites:
#   brew install llama.cpp  (provides llama-export-lora, llama-quantize)
#   ollama running
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
SBLU_NAME=""
ADAPTER_DIR=""
BASE_MODEL=""
QUANT="Q4_K_M"
VERSION="v1"
VAULT_PATH="${VAULT_PATH:-}"
DRY_RUN=false
WORK_DIR="/tmp/sblu-convert-$$"

# ── Model map (SBLU name → HuggingFace model ID) ─────────────────────────────
declare -A MODEL_MAP
# All SBLUs standardized on Qwen 3.5 family (2026-03-17)
MODEL_MAP["cartographer"]="mlx-community/Qwen3.5-2B-OptiQ-4bit"
MODEL_MAP["crystallizer"]="mlx-community/Qwen3.5-2B-OptiQ-4bit"
MODEL_MAP["pulse"]="mlx-community/Qwen3.5-2B-OptiQ-4bit"
MODEL_MAP["weaver"]="mlx-community/Qwen3.5-2B-OptiQ-4bit"
MODEL_MAP["world-lens"]="mlx-community/Qwen3.5-2B-OptiQ-4bit"
MODEL_MAP["auditor"]="mlx-community/Qwen3.5-2B-OptiQ-4bit"

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --sblu)    SBLU_NAME="$2"; shift 2 ;;
        --adapter) ADAPTER_DIR="$2"; shift 2 ;;
        --base)    BASE_MODEL="$2"; shift 2 ;;
        --quant)   QUANT="$2"; shift 2 ;;
        --version) VERSION="$2"; shift 2 ;;
        --vault)   VAULT_PATH="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

if [[ -z "$SBLU_NAME" || -z "$ADAPTER_DIR" ]]; then
    echo "Error: --sblu and --adapter are required"
    exit 1
fi

if [[ -z "$BASE_MODEL" ]]; then
    BASE_MODEL="${MODEL_MAP[$SBLU_NAME]:-}"
    if [[ -z "$BASE_MODEL" ]]; then
        echo "Error: No model mapping for '$SBLU_NAME'. Use --base <hf-id>"
        exit 1
    fi
fi

OLLAMA_TAG="sblu-${SBLU_NAME}:${VERSION}"
OLLAMA_BASELINE_TAG="sblu-${SBLU_NAME}:baseline"
GGUF_PATH="${WORK_DIR}/sblu-${SBLU_NAME}-${VERSION}.gguf"
GGUF_QUANT_PATH="${WORK_DIR}/sblu-${SBLU_NAME}-${VERSION}-${QUANT}.gguf"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║         SBLU GGUF Conversion & Registration           ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  SBLU:         $SBLU_NAME"
echo "║  Adapter:      $ADAPTER_DIR"
echo "║  Base model:   $BASE_MODEL"
echo "║  Quantization: $QUANT"
echo "║  Ollama tag:   $OLLAMA_TAG"
echo "║  Work dir:     $WORK_DIR"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] Would convert and register. Exiting."
    exit 0
fi

# ── Resolve Python ────────────────────────────────────────────────────────────
SBLU_PYTHON="${SBLU_PYTHON:-${SBLU_VENV:-$HOME/.sblu-env}/bin/python3}"
if [[ ! -x "$SBLU_PYTHON" ]]; then SBLU_PYTHON="python3"; fi

# ── Check prerequisites ───────────────────────────────────────────────────────
if ! command -v llama-export-lora &>/dev/null && ! command -v llama.cpp &>/dev/null; then
    echo "Error: llama.cpp not found. Run: brew install llama.cpp"
    exit 1
fi

if ! command -v ollama &>/dev/null; then
    echo "Error: ollama not found. See https://ollama.com"
    exit 1
fi

mkdir -p "$WORK_DIR"

# ── Step 1: Merge LoRA adapter into base model (MLX format) ──────────────────
echo "Step 1: Merging LoRA adapter into base model..."
MERGED_DIR="${WORK_DIR}/merged-mlx"

"$SBLU_PYTHON" -m mlx_lm.fuse \
    --model "$BASE_MODEL" \
    --adapter-path "$ADAPTER_DIR" \
    --save-path "$MERGED_DIR"

echo "  ✓ Merged model saved to $MERGED_DIR"

# ── Step 2: Convert to GGUF ───────────────────────────────────────────────────
echo ""
echo "Step 2: Converting merged MLX model to GGUF..."

# Use mlx_lm's built-in GGUF export if available
if "$SBLU_PYTHON" -c "from mlx_lm import convert" 2>/dev/null; then
    "$SBLU_PYTHON" -m mlx_lm.convert \
        --hf-path "$MERGED_DIR" \
        --mlx-path "$WORK_DIR/gguf-out" \
        --quantize \
        --q-bits 4
    GGUF_PATH=$(find "$WORK_DIR/gguf-out" -name "*.gguf" | head -1)
else
    # Fallback: use llama.cpp conversion script
    echo "  mlx_lm convert not available, using llama.cpp directly..."
    python3 "$(brew --prefix llama.cpp)/bin/convert-hf-to-gguf.py" \
        "$MERGED_DIR" \
        --outfile "$GGUF_PATH" \
        --outtype f16

    echo ""
    echo "Step 2b: Quantizing to $QUANT..."
    llama-quantize "$GGUF_PATH" "$GGUF_QUANT_PATH" "$QUANT"
    GGUF_PATH="$GGUF_QUANT_PATH"
fi

echo "  ✓ GGUF model: $GGUF_PATH"

# ── Step 3: Create Ollama Modelfile ──────────────────────────────────────────
echo ""
echo "Step 3: Creating Ollama Modelfile..."

MODELFILE_PATH="${WORK_DIR}/Modelfile"
cat > "$MODELFILE_PATH" << MODELFILE_EOF
FROM $GGUF_PATH

SYSTEM """You are SBLU-1 Vault Cartographer, a precision knowledge graph analyst. You identify structural gaps in a personal knowledge vault by analyzing file paths and note titles. You output only valid JSON matching the requested schema. No prose, no markdown fences."""

PARAMETER temperature 0.1
PARAMETER top_p 0.9
PARAMETER num_predict 1024
MODELFILE_EOF

echo "  ✓ Modelfile created"

# ── Step 4: Register in Ollama ────────────────────────────────────────────────
echo ""
echo "Step 4: Registering $OLLAMA_TAG in Ollama..."

ollama create "$OLLAMA_TAG" -f "$MODELFILE_PATH"

# Also tag as baseline for rollback safety
echo "  Tagging as $OLLAMA_BASELINE_TAG (rollback point)..."
ollama create "$OLLAMA_BASELINE_TAG" -f "$MODELFILE_PATH"

echo "  ✓ Registered $OLLAMA_TAG and $OLLAMA_BASELINE_TAG"

# ── Step 5: Update SBLU-REGISTRY.md ──────────────────────────────────────────
if [[ -n "$VAULT_PATH" && -f "${VAULT_PATH}/_system/SBLU-REGISTRY.md" ]]; then
    echo ""
    echo "Step 5: Updating SBLU-REGISTRY.md..."

    TRAINED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    REGISTRY_FILE="${VAULT_PATH}/_system/SBLU-REGISTRY.md"

    # Update the model and trainedAt fields for this SBLU
    # Uses perl for reliable multi-line regex on macOS
    perl -i -0pe "
        s/(### ${SBLU_NAME}\s+\`\`\`yaml[\s\S]*?model: )null/\${1}${OLLAMA_TAG}/;
        s/(### ${SBLU_NAME}\s+\`\`\`yaml[\s\S]*?trainedAt: )null/\${1}${TRAINED_AT}/;
    " "$REGISTRY_FILE"

    echo "  ✓ Registry updated: model=$OLLAMA_TAG trainedAt=$TRAINED_AT"
    echo "  Manually update trustLevel from 0 to 1 to start shadow mode:"
    echo "  vim ${REGISTRY_FILE}"
else
    echo ""
    echo "Step 5: (Skipped — VAULT_PATH not set or registry not found)"
    echo "  Manually update _system/SBLU-REGISTRY.md:"
    echo "  model: ${OLLAMA_TAG}"
    echo "  trainedAt: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
fi

# ── Cleanup ───────────────────────────────────────────────────────────────────
echo ""
echo "Cleaning up work directory..."
rm -rf "$WORK_DIR"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✓ SBLU-1 Cartographer registered in Ollama!         ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Model:    $OLLAMA_TAG"
echo "║  Rollback: $OLLAMA_BASELINE_TAG"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "Test it:"
echo "  ollama run $OLLAMA_TAG 'Analyze this vault: ...'"
echo ""
echo "Start shadow mode by setting trustLevel: 1 in SBLU-REGISTRY.md"
