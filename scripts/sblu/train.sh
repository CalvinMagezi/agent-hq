#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# SBLU LoRA Fine-Tuning Script (MLX-LM on Apple Silicon)
#
# Usage:
#   bash scripts/sblu/train.sh --sblu cartographer [options]
#
# Required:
#   --sblu <name>       SBLU name (e.g. cartographer)
#
# Options:
#   --data <path>       Training JSONL file (default: /tmp/sblu-<name>-train.jsonl)
#   --val  <path>       Validation JSONL file (default: /tmp/sblu-<name>-val.jsonl)
#   --model <hf-id>     Base model HuggingFace ID (default: auto from SBLU name)
#   --iters <n>         Training iterations (default: 600)
#   --batch <n>         Batch size (default: 4)
#   --rank <n>          LoRA rank (default: 8)
#   --output <dir>      Output directory for adapter weights (default: /tmp/sblu-<name>-adapter)
#   --dry-run           Print config without training
#
# Prerequisites:
#   pip install mlx-lm
#   ollama pull gemma3:1b  (or appropriate base model)
#
# After training, run:
#   bash scripts/sblu/convert.sh --sblu cartographer --adapter <output-dir>
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
SBLU_NAME=""
ITERS=600
BATCH_SIZE=4
LORA_RANK=8
DRY_RUN=false
BASE_MODEL=""
DATA_FILE=""
VAL_FILE=""
OUTPUT_DIR=""

# ── Model map (SBLU name → HuggingFace model ID for MLX) ─────────────────────
declare -A MODEL_MAP
MODEL_MAP["cartographer"]="mlx-community/gemma-3-1b-it-4bit"
MODEL_MAP["crystallizer"]="mlx-community/gemma-3-4b-it-4bit"
MODEL_MAP["pulse"]="mlx-community/Qwen2.5-3B-Instruct-4bit"
MODEL_MAP["weaver"]="mlx-community/SmolLM2-1.7B-Instruct-4bit"
MODEL_MAP["world-lens"]="mlx-community/phi-4-mini-instruct-4bit"
MODEL_MAP["auditor"]="mlx-community/gemma-3-1b-it-4bit"

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --sblu)   SBLU_NAME="$2"; shift 2 ;;
        --data)   DATA_FILE="$2"; shift 2 ;;
        --val)    VAL_FILE="$2"; shift 2 ;;
        --model)  BASE_MODEL="$2"; shift 2 ;;
        --iters)  ITERS="$2"; shift 2 ;;
        --batch)  BATCH_SIZE="$2"; shift 2 ;;
        --rank)   LORA_RANK="$2"; shift 2 ;;
        --output) OUTPUT_DIR="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

if [[ -z "$SBLU_NAME" ]]; then
    echo "Error: --sblu <name> required"
    exit 1
fi

# ── Resolve defaults ──────────────────────────────────────────────────────────
DATA_FILE="${DATA_FILE:-/tmp/sblu-${SBLU_NAME}-train.jsonl}"
VAL_FILE="${VAL_FILE:-/tmp/sblu-${SBLU_NAME}-val.jsonl}"
OUTPUT_DIR="${OUTPUT_DIR:-/tmp/sblu-${SBLU_NAME}-adapter}"

if [[ -z "$BASE_MODEL" ]]; then
    BASE_MODEL="${MODEL_MAP[$SBLU_NAME]:-}"
    if [[ -z "$BASE_MODEL" ]]; then
        echo "Error: No model mapping for SBLU '$SBLU_NAME'. Use --model <hf-id>"
        exit 1
    fi
fi

# ── Validate ──────────────────────────────────────────────────────────────────
if [[ ! -f "$DATA_FILE" ]]; then
    echo "Error: Training data not found: $DATA_FILE"
    echo "Run: bun scripts/sblu/extract.ts --sblu $SBLU_NAME --vault \$VAULT_PATH"
    exit 1
fi

if [[ ! -f "$VAL_FILE" ]]; then
    echo "Warning: Validation file not found: $VAL_FILE — training without validation"
    VAL_FILE=""
fi

# ── Resolve Python (use dedicated SBLU venv if available) ─────────────────────
SBLU_PYTHON="${SBLU_PYTHON:-${SBLU_VENV:-/Users/calvinmagezi/.sblu-env}/bin/python3}"
if [[ ! -x "$SBLU_PYTHON" ]]; then
    SBLU_PYTHON="python3"
fi

# ── Check mlx-lm ─────────────────────────────────────────────────────────────
if ! "$SBLU_PYTHON" -c "import mlx_lm" 2>/dev/null; then
    echo "Error: mlx-lm not installed in $SBLU_PYTHON"
    echo "Run: python3 -m venv ~/.sblu-env && ~/.sblu-env/bin/pip install mlx-lm"
    exit 1
fi

# ── Count training examples ───────────────────────────────────────────────────
TRAIN_COUNT=$(wc -l < "$DATA_FILE" | tr -d ' ')
VAL_COUNT=0
if [[ -n "$VAL_FILE" ]]; then
    VAL_COUNT=$(wc -l < "$VAL_FILE" | tr -d ' ')
fi

# ── Print config ──────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║         SBLU Fine-Tuning Configuration               ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  SBLU:        $SBLU_NAME"
echo "║  Base model:  $BASE_MODEL"
echo "║  Training:    $DATA_FILE ($TRAIN_COUNT examples)"
echo "║  Validation:  ${VAL_FILE:-none} (${VAL_COUNT} examples)"
echo "║  Output:      $OUTPUT_DIR"
echo "║  Iterations:  $ITERS"
echo "║  Batch size:  $BATCH_SIZE"
echo "║  LoRA rank:   $LORA_RANK"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] Would train now. Exiting."
    exit 0
fi

# ── Estimate time ─────────────────────────────────────────────────────────────
# ~8 sec/iter on M4, so 600 iters ≈ 80 minutes
EST_MINS=$(( ITERS * 8 / 60 ))
echo "Estimated training time: ~${EST_MINS} minutes on M4 MacBook Pro"
echo "Training will run in background. Output: $OUTPUT_DIR"
echo ""

# ── Create output directory ───────────────────────────────────────────────────
mkdir -p "$OUTPUT_DIR"

# ── Build mlx_lm.lora command ─────────────────────────────────────────────────
CMD=(
    "$SBLU_PYTHON" -m mlx_lm.lora
    --model "$BASE_MODEL"
    --train
    --data "$DATA_FILE"
    --iters "$ITERS"
    --batch-size "$BATCH_SIZE"
    --lora-parameters.rank "$LORA_RANK"
    --lora-parameters.alpha "$(( LORA_RANK * 2 ))"
    --adapter-path "$OUTPUT_DIR"
    --learning-rate 2e-5
    --max-seq-length 2048
    --grad-checkpoint
)

if [[ -n "$VAL_FILE" ]]; then
    CMD+=(--val-batches 20)
fi

LOG_FILE="$OUTPUT_DIR/train.log"

echo "Starting training..."
echo "Log: $LOG_FILE"
echo ""

# Run training, logging to file
"${CMD[@]}" 2>&1 | tee "$LOG_FILE"

echo ""
echo "✓ Training complete!"
echo "  Adapter weights: $OUTPUT_DIR"
echo ""
echo "Next step:"
echo "  bash scripts/sblu/convert.sh --sblu $SBLU_NAME --adapter $OUTPUT_DIR --base $BASE_MODEL"
