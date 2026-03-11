use napi::bindgen_prelude::*;
use rayon::prelude::*;

/// Compute dot product and norms in f32 (enables NEON auto-vectorization),
/// then do the final division in f64 for precision.
#[inline(always)]
fn cosine_sim_f32(a: &[f32], b: &[f32]) -> f64 {
    debug_assert_eq!(a.len(), b.len());

    let mut dot: f32 = 0.0;
    let mut norm_a: f32 = 0.0;
    let mut norm_b: f32 = 0.0;

    // Staying in f32 lets rustc emit NEON vfma.f32 instructions
    for i in 0..a.len() {
        let ai = a[i];
        let bi = b[i];
        dot += ai * bi;
        norm_a += ai * ai;
        norm_b += bi * bi;
    }

    let denom = (norm_a as f64).sqrt() * (norm_b as f64).sqrt();
    if denom == 0.0 {
        0.0
    } else {
        (dot as f64) / denom
    }
}

#[napi]
pub fn cosine_similarity(a: Buffer, b: Buffer) -> f64 {
    let a_slice = unsafe { std::slice::from_raw_parts(a.as_ptr() as *const f32, a.len() / 4) };
    let b_slice = unsafe { std::slice::from_raw_parts(b.as_ptr() as *const f32, b.len() / 4) };

    if a_slice.len() != b_slice.len() || a_slice.is_empty() {
        return 0.0;
    }

    cosine_sim_f32(a_slice, b_slice)
}

#[napi]
pub fn batch_cosine_similarity(query: Buffer, matrix: Buffer, dim: u32) -> Vec<f64> {
    let dim = dim as usize;
    let query_slice = unsafe { std::slice::from_raw_parts(query.as_ptr() as *const f32, query.len() / 4) };
    let matrix_slice = unsafe { std::slice::from_raw_parts(matrix.as_ptr() as *const f32, matrix.len() / 4) };

    if query_slice.len() != dim || matrix_slice.is_empty() {
        return Vec::new();
    }

    let num_vectors = matrix_slice.len() / dim;

    // Use rayon for large batches (>64 vectors), sequential for small ones
    if num_vectors > 64 {
        (0..num_vectors)
            .into_par_iter()
            .map(|i| {
                let start = i * dim;
                let vec = &matrix_slice[start..start + dim];
                cosine_sim_f32(query_slice, vec)
            })
            .collect()
    } else {
        let mut results = Vec::with_capacity(num_vectors);
        for i in 0..num_vectors {
            let start = i * dim;
            let vec = &matrix_slice[start..start + dim];
            results.push(cosine_sim_f32(query_slice, vec));
        }
        results
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_identical_vectors() {
        let a = vec![1.0f32, 2.0, 3.0, 4.0];
        let b = vec![1.0f32, 2.0, 3.0, 4.0];
        let result = cosine_sim_f32(&a, &b);
        assert!((result - 1.0).abs() < 1e-5, "Expected ~1.0, got {}", result);
    }

    #[test]
    fn test_orthogonal_vectors() {
        let a = vec![1.0f32, 0.0, 0.0];
        let b = vec![0.0f32, 1.0, 0.0];
        let result = cosine_sim_f32(&a, &b);
        assert!(result.abs() < 1e-5, "Expected ~0.0, got {}", result);
    }

    #[test]
    fn test_opposite_vectors() {
        let a = vec![1.0f32, 2.0, 3.0];
        let b = vec![-1.0f32, -2.0, -3.0];
        let result = cosine_sim_f32(&a, &b);
        assert!((result + 1.0).abs() < 1e-5, "Expected ~-1.0, got {}", result);
    }
}
