//! Automated Google Drive folder colorizer for sync pairs.
//!
//! Provides the 24 official Google Drive folder colors, ordered so that bright,
//! vibrant, and high-contrast colors are preferred first. Sibling folders under the same
//! parent are assigned distinct colors from the 24-color palette in a deterministic order
//! so no two siblings repeat colors unless the 24-color palette is exhausted.

use std::collections::{HashSet, VecDeque};
use crate::drive::client::DriveClient;
use crate::error::AppError;

/// The 24 official Google Drive folder colors, ordered so that bright,
/// high-contrast, vibrant colors are preferred first, with alternating hues
/// so adjacent siblings stand out clearly.
pub const DRIVE_PALETTE_24: [&str; 24] = [
    "#4986e7", // 0: Denim Blue (Google Blue, bright)
    "#16a765", // 1: Sea Green (Emerald, bright)
    "#ffad46", // 2: Macaroni (Bright Orange)
    "#cd74e6", // 3: Purple (Vivid Orchid)
    "#f83a22", // 4: Mars Orange (Bright Crimson Red)
    "#9fe1e7", // 5: Cerulean (Bright Cyan / Turquoise)
    "#fad165", // 6: Lemon (Bright Yellow)
    "#f691b2", // 7: Bubblegum (Bright Pink)
    "#42d692", // 8: Slime Green (Bright Mint Green)
    "#3f51b5", // 9: Dark Blue (Vivid Indigo)
    "#ff7537", // 10: Orange (Vivid Coral)
    "#b99aff", // 11: Amethyst (Bright Periwinkle)
    "#7bd148", // 12: Olive (Bright Lime Green)
    "#fa573c", // 13: Yellow Orange (Bright Tangerine)
    "#9fc6e7", // 14: Cobalt (Sky Blue)
    "#92e1c0", // 15: Peacock (Seafoam Green)
    "#a479c1", // 16: Lilac (Medium Purple)
    "#fbe983", // 17: Desert Yellow (Pastel Sun Yellow)
    "#b3dc6c", // 18: Sage (Light Green)
    "#d06b64", // 19: Deep Red
    "#cca6ac", // 20: Valentine
    "#ac725e", // 21: Chocolate
    "#cabdbf", // 22: Slate
    "#c2c2c2", // 23: Mouse Gray
];

/// Returns the index of a hex color in the 24-color palette, case-insensitively.
pub fn palette_index_of(color: Option<&str>) -> Option<usize> {
    let c = color?.trim();
    DRIVE_PALETTE_24.iter().position(|&p| p.eq_ignore_ascii_case(c))
}

/// Computes the assigned color for a sibling folder at index `sibling_idx` (0-based)
/// under a parent whose color index is `parent_idx`.
///
/// Guarantees:
/// 1. Sibling `i` and Sibling `j` have distinct colors for all 0 <= i < j < 24.
/// 2. Colors only repeat when the 24-color palette is exhausted (sibling_idx >= 24).
/// 3. For the first 23 siblings (sibling_idx < 23), the assigned color is distinct from the parent.
pub fn get_sibling_color(parent_idx: usize, sibling_idx: usize) -> &'static str {
    let color_idx = (parent_idx + 1 + sibling_idx) % DRIVE_PALETTE_24.len();
    DRIVE_PALETTE_24[color_idx]
}

/// Picks the best next bright color for a newly created folder under a parent,
/// given the parent's color index and the colors already in use by existing siblings.
pub fn pick_next_available_sibling_color(parent_idx: usize, used_colors: &[String]) -> &'static str {
    // Try to find the first unused color in the sibling color progression
    for i in 0..DRIVE_PALETTE_24.len() {
        let candidate = get_sibling_color(parent_idx, i);
        if !used_colors.iter().any(|u| u.trim().eq_ignore_ascii_case(candidate)) {
            return candidate;
        }
    }
    // If all 24 colors are already in use, wrap around based on count
    get_sibling_color(parent_idx, used_colors.len())
}

/// Colorizes the entire Google Drive folder tree for a sync pair.
///
/// - Assigns the parent/root folder a distinct bright color based on `pair_index`.
/// - Recursively traverses all subfolders level by level.
/// - Sorts sibling folders at each level deterministically by name (case-insensitive).
/// - Assigns each sibling a unique color from the 24-color bright palette without repeating
///   until the 24 colors are exhausted.
/// - Only issues API updates if the folder's existing color differs from the assigned color.
pub async fn colorize_pair_folder_tree(
    drive: &DriveClient,
    root_folder_id: &str,
    pair_index: usize,
) -> Result<usize, AppError> {
    if root_folder_id.trim().is_empty() {
        return Ok(0);
    }

    let mut updated_count = 0;

    // 1. Colorize the parent folder concerned with the pair.
    let root_color_idx = pair_index % DRIVE_PALETTE_24.len();
    let root_target_color = DRIVE_PALETTE_24[root_color_idx];

    match drive.get_folder_meta(root_folder_id).await {
        Ok(meta) => {
            let cur = meta.folder_color_rgb.as_deref();
            if cur != Some(root_target_color) {
                if let Err(e) = drive.set_folder_color(root_folder_id, Some(root_target_color)).await {
                    tracing::warn!("Failed to set root folder color for {root_folder_id}: {e}");
                } else {
                    updated_count += 1;
                }
            }
        }
        Err(e) => {
            tracing::warn!("Failed to get root folder meta for {root_folder_id}: {e}");
            // Still attempt to set color
            let _ = drive.set_folder_color(root_folder_id, Some(root_target_color)).await;
        }
    }

    // 2. Level-by-level BFS traversal of all subfolders
    let mut queue: VecDeque<(String, usize)> = VecDeque::new();
    queue.push_back((root_folder_id.to_string(), root_color_idx));

    let mut visited: HashSet<String> = HashSet::new();
    visited.insert(root_folder_id.to_string());

    while let Some((parent_id, parent_col_idx)) = queue.pop_front() {
        let mut subfolders = match drive.list_subfolders(&parent_id).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("Failed to list subfolders for {parent_id}: {e}");
                continue;
            }
        };

        if subfolders.is_empty() {
            continue;
        }

        // Sort siblings deterministically: case-insensitive name, then ID
        subfolders.sort_by(|a, b| {
            let na = a.name.as_deref().unwrap_or("").to_lowercase();
            let nb = b.name.as_deref().unwrap_or("").to_lowercase();
            na.cmp(&nb).then_with(|| a.id.cmp(&b.id))
        });

        for (sibling_idx, child) in subfolders.into_iter().enumerate() {
            let child_col_idx = (parent_col_idx + 1 + sibling_idx) % DRIVE_PALETTE_24.len();
            let target_color = DRIVE_PALETTE_24[child_col_idx];

            let cur_color = child.folder_color_rgb.as_deref();
            if cur_color != Some(target_color) {
                if let Err(e) = drive.set_folder_color(&child.id, Some(target_color)).await {
                    tracing::warn!(
                        "Failed to colorize child folder {} ({}): {e}",
                        child.id,
                        child.name.as_deref().unwrap_or("")
                    );
                } else {
                    updated_count += 1;
                }
            }

            if visited.insert(child.id.clone()) {
                queue.push_back((child.id, child_col_idx));
            }
        }
    }

    Ok(updated_count)
}

/// Colorizes the Google Drive folders for all configured pairs.
pub async fn colorize_all_pairs(drive: &DriveClient) -> Result<usize, AppError> {
    let cfg = crate::config::load().unwrap_or_default();
    let mut total_updated = 0;
    for (pair_idx, pair) in cfg.pairs.iter().enumerate() {
        if !pair.drive_folder_id.is_empty() {
            match colorize_pair_folder_tree(drive, &pair.drive_folder_id, pair_idx).await {
                Ok(count) => {
                    total_updated += count;
                    tracing::info!(
                        "Pair '{}' (folder {}): colorized {} folders",
                        &pair.id,
                        pair.drive_folder_id,
                        count
                    );
                }
                Err(e) => {
                    tracing::error!("Failed to colorize pair {}: {e}", pair.id);
                }
            }
        }
    }
    Ok(total_updated)
}
