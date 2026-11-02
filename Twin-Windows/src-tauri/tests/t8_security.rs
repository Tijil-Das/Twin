//! Phase T8: Security & Access Control Tests
//! Target: Path traversal sanitization, TLS safety, secret leak grep, untrusted input boundaries.

use std::fs;
use std::path::{Path, PathBuf};

// ── 1. Path Traversal & Destination Escape Sanitization ────────────────────────

fn sanitize_rel_path(untrusted: &str) -> PathBuf {
    let mut clean = PathBuf::new();
    for component in Path::new(untrusted).components() {
        match component {
            std::path::Component::Normal(c) => {
                let s = c.to_string_lossy();
                // Strip Windows reserved names & colons (ADS streams)
                let name = s.split(':').next().unwrap_or("");
                let sanitized = match name.to_ascii_uppercase().as_str() {
                    "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4"
                    | "LPT1" | "LPT2" | "LPT3" => format!("_{name}"),
                    _ => name.to_string(),
                };
                if !sanitized.is_empty() {
                    clean.push(sanitized);
                }
            }
            // Disallow parent directory (`..`), rootdir, prefix
            std::path::Component::ParentDir => {}
            std::path::Component::RootDir => {}
            std::path::Component::Prefix(_) => {}
            std::path::Component::CurDir => {}
        }
    }
    clean
}

#[test]
fn test_path_traversal_sanitization() {
    let base_root = PathBuf::from("C:\\Users\\User\\TwinSync");

    let attack_inputs = [
        "../../../../Windows/System32/cmd.exe",
        "..\\..\\..\\Windows\\System32\\calc.exe",
        "/etc/passwd",
        "\\root\\secret.txt",
        "file.txt:hidden_stream",
        "CON",
        "NUL",
        "sub/../../escape.txt",
        "foo/bar/../../../baz.txt",
    ];

    for attack in attack_inputs {
        let rel = sanitize_rel_path(attack);
        let target = base_root.join(&rel);

        // Security assertion: target MUST stay within base_root!
        assert!(
            target.starts_with(&base_root),
            "Path traversal escape detected! Attack '{attack}' resolved to '{target:?}' outside root"
        );
        // Ensure no '..' components survive
        for c in target.components() {
            assert_ne!(
                c,
                std::path::Component::ParentDir,
                "ParentDir '..' survived sanitization in: {target:?}"
            );
        }
    }
}

// ── 2. TLS Security & Certificate Bypass Audit ────────────────────────────────

#[test]
fn test_tls_danger_accept_invalid_certs_absent() {
    // Grep all Rust source code to guarantee that no developer accidentally introduced
    // `danger_accept_invalid_certs` or `danger_accept_invalid_hostnames`
    let src_dir = Path::new("src");
    let mut files_to_scan = Vec::new();

    fn collect_rs_files(dir: &Path, list: &mut Vec<PathBuf>) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    collect_rs_files(&p, list);
                } else if p.extension().and_then(|s| s.to_str()) == Some("rs") {
                    list.push(p);
                }
            }
        }
    }

    collect_rs_files(src_dir, &mut files_to_scan);
    assert!(!files_to_scan.is_empty(), "Must scan source files");

    for file in files_to_scan {
        let content = fs::read_to_string(&file).expect("read rs file");
        assert!(
            !content.contains("danger_accept_invalid_certs"),
            "CRITICAL SECURITY VIOLATION: 'danger_accept_invalid_certs' found in {:?}",
            file
        );
        assert!(
            !content.contains("danger_accept_invalid_hostnames"),
            "CRITICAL SECURITY VIOLATION: 'danger_accept_invalid_hostnames' found in {:?}",
            file
        );
    }
}

// ── 3. Secret Leakage Audit in Source and Sample Configs ──────────────────────

#[test]
fn test_no_hardcoded_secrets_in_repo() {
    let banned_patterns = [
        "ghp_",
        "github_pat_",
        "AIzaSy", // Google API key prefix
        "xoxb-",  // Slack token
    ];

    let files_to_check = [
        "src/auth/mod.rs",
        "src/github/client.rs",
        "src/drive/client.rs",
        "src/config/mod.rs",
    ];

    for file in files_to_check {
        let p = Path::new(file);
        if p.exists() {
            let content = fs::read_to_string(p).expect("read file");
            for pattern in banned_patterns {
                assert!(
                    !content.contains(pattern),
                    "CRITICAL SECRET LEAK: Found pattern '{pattern}' in source file {file}"
                );
            }
        }
    }
}
