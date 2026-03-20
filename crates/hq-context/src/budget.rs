//! Token budget allocation and surplus cascading.

use std::collections::HashMap;

use hq_core::types::BudgetProfile;

/// The four built-in budget profiles.
pub fn profile_by_name(name: &str) -> BudgetProfile {
    match name {
        "quick" => BudgetProfile {
            response_reserve: 0.40,
            system: 0.08,
            user_message: 0.12,
            memory: 0.05,
            thread: 0.20,
            injections: 0.15,
        },
        "thorough" => BudgetProfile {
            response_reserve: 0.25,
            system: 0.06,
            user_message: 0.08,
            memory: 0.06,
            thread: 0.30,
            injections: 0.25,
        },
        "delegation" => BudgetProfile {
            response_reserve: 0.35,
            system: 0.10,
            user_message: 0.15,
            memory: 0.05,
            thread: 0.10,
            injections: 0.25,
        },
        // "standard" and anything else
        _ => BudgetProfile {
            response_reserve: 0.30,
            system: 0.08,
            user_message: 0.10,
            memory: 0.07,
            thread: 0.25,
            injections: 0.20,
        },
    }
}

/// Layer keys in allocation order.
const LAYER_KEYS: &[&str] = &[
    "response",
    "system",
    "user_message",
    "memory",
    "thread",
    "injections",
];

/// Compute initial token allocations from a budget profile.
pub fn compute_allocations(
    total_tokens: usize,
    profile: &BudgetProfile,
) -> HashMap<String, usize> {
    let total = total_tokens as f64;
    let mut allocs = HashMap::new();
    allocs.insert("response".to_string(), (total * profile.response_reserve) as usize);
    allocs.insert("system".to_string(), (total * profile.system) as usize);
    allocs.insert("user_message".to_string(), (total * profile.user_message) as usize);
    allocs.insert("memory".to_string(), (total * profile.memory) as usize);
    allocs.insert("thread".to_string(), (total * profile.thread) as usize);
    allocs.insert("injections".to_string(), (total * profile.injections) as usize);
    allocs
}

/// Redistribute unused tokens from layers that underspent their budget.
///
/// `allocations` — the original per-layer allocations.
/// `usage` — actual tokens used per layer.
///
/// Surplus is distributed: thread=0.50, injections=0.35, memory=0.15.
pub fn cascade_surplus(
    allocations: &HashMap<String, usize>,
    usage: &HashMap<String, usize>,
) -> HashMap<String, usize> {
    let mut result = allocations.clone();

    // Calculate total surplus across all layers.
    let mut surplus: usize = 0;
    for key in LAYER_KEYS {
        let alloc = allocations.get(*key).copied().unwrap_or(0);
        let used = usage.get(*key).copied().unwrap_or(0);
        if used < alloc {
            surplus += alloc - used;
        }
    }

    if surplus == 0 {
        return result;
    }

    // Distribute surplus to expandable layers.
    let cascade_weights: &[(&str, f64)] = &[
        ("thread", 0.50),
        ("injections", 0.35),
        ("memory", 0.15),
    ];

    for (key, weight) in cascade_weights {
        let bonus = (surplus as f64 * weight) as usize;
        *result.entry(key.to_string()).or_insert(0) += bonus;
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_allocations_sum_correctly() {
        let profile = profile_by_name("standard");
        let total = profile.response_reserve
            + profile.system
            + profile.user_message
            + profile.memory
            + profile.thread
            + profile.injections;
        assert!((total - 1.0).abs() < 1e-9);
    }

    #[test]
    fn all_profiles_sum_to_one() {
        for name in &["quick", "standard", "thorough", "delegation"] {
            let p = profile_by_name(name);
            let total = p.response_reserve + p.system + p.user_message + p.memory + p.thread + p.injections;
            assert!(
                (total - 1.0).abs() < 1e-9,
                "profile {name} sums to {total}"
            );
        }
    }

    #[test]
    fn cascade_redistributes_surplus() {
        let allocs = compute_allocations(10000, &profile_by_name("standard"));
        // Pretend system used 0 tokens (800 surplus from system alone)
        let mut usage = allocs.clone();
        usage.insert("system".to_string(), 0);

        let cascaded = cascade_surplus(&allocs, &usage);
        // thread should have gained 50% of 800 = 400
        assert!(cascaded["thread"] > allocs["thread"]);
    }
}
