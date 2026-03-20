//! Fast token counting and truncation.
//!
//! Uses a bytes/4 heuristic (roughly bytes/3.5, rounded) which is
//! accurate enough for budget planning without pulling in a real
//! tokenizer dependency.

/// Estimate token count using the bytes/4 heuristic.
///
/// This intentionally over-counts slightly to stay within budget.
#[inline]
pub fn count_tokens_fast(text: &str) -> usize {
    // bytes / 3.5 ≈ (bytes * 2) / 7, rounded up
    (text.len() * 2 + 6) / 7
}

/// Truncate `text` to fit within `max_tokens`, snapping to a word
/// boundary and appending an ellipsis marker.
///
/// Returns the original string unchanged if it already fits.
pub fn truncate_to_tokens(text: &str, max_tokens: usize) -> String {
    if count_tokens_fast(text) <= max_tokens {
        return text.to_string();
    }

    // Approximate byte budget (tokens * 3.5 ≈ tokens * 7 / 2)
    let byte_budget = max_tokens * 7 / 2;
    let byte_budget = byte_budget.min(text.len());

    // Find the last newline within budget, falling back to last space,
    // falling back to the raw byte budget.
    let cut = text[..byte_budget]
        .rfind('\n')
        .or_else(|| text[..byte_budget].rfind(' '))
        .unwrap_or(byte_budget);

    let mut result = text[..cut].to_string();
    result.push_str("\n... (truncated)");
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_string() {
        assert_eq!(count_tokens_fast(""), 0);
    }

    #[test]
    fn short_text() {
        // 11 bytes -> (22 + 6) / 7 = 4
        assert_eq!(count_tokens_fast("hello world"), 4);
    }

    #[test]
    fn truncate_noop_when_fits() {
        let text = "short text";
        assert_eq!(truncate_to_tokens(text, 100), text);
    }

    #[test]
    fn truncate_snaps_to_boundary() {
        let text = "word1 word2 word3 word4 word5 word6 word7 word8";
        let result = truncate_to_tokens(text, 5);
        assert!(result.ends_with("... (truncated)"));
        assert!(result.len() < text.len() + 20);
    }
}
