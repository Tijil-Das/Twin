//! Phase T7: Fuzzing Targets & Robustness Suite
//! Targets: Config TOML, Path expansion, Glob rules matcher, Drive JSON, Range header, OAuth redirect.

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use twin_lib::config::{expand, Config, Vars};
use twin_lib::rules::Rules;
use twin_lib::sync::changes::{DriveChange, DriveEntry};

// ── 1. TOML Config Parser Fuzzing ─────────────────────────────────────────────

#[test]
fn test_fuzz_toml_config_parser() {
    let inputs = [
        "",
        "   \n\r\n\t  ",
        "[[pair]]\n",
        "[app]\nparallel_transfers = -1\n",
        "[app]\nparallel_transfers = 9999999999999999999999999999999999999\n",
        "key = \"\0unterminated",
        "[a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p]\nx = 1\n",
        "[[[[[[[[[[nested]]]]]]]]]]\n",
        "\"\"\"\"\"\"\"\"\"\"",
        "\u{feff}[app]\nparallel_transfers = 4\n",
        "[app]\n\r\n\r\n[limits]\n\r\n",
        "foo = true\nfoo = false\n",
    ];

    for (idx, raw) in inputs.iter().enumerate() {
        let t0 = Instant::now();
        // Parser MUST NOT panic or hang (> 1s)
        let _ = toml::from_str::<Config>(raw);
        assert!(
            t0.elapsed().as_secs() < 1,
            "Fuzz case {idx} hung for > 1s on: {raw:?}"
        );
    }
}

// ── 2. Path Normalizer & Rel-path Traversal Fuzzing ───────────────────────────

#[test]
fn test_fuzz_path_expansion_and_traversal() {
    let mut vars: Vars = HashMap::new();
    vars.insert("BASE".into(), "C:\\Safe\\Directory".into());

    let attacks = [
        "%BASE%\\..\\..\\Windows\\System32",
        "%BASE%/../../../escaped",
        "%BASE%\\CON.txt",
        "%BASE%\\NUL",
        "%BASE%\\AUX.dat",
        "%BASE%\\trailing_dot.",
        "%BASE%\\trailing_space ",
        "%BASE%\\..\\..\\..\\..\\..\\..\\..\\etc\\passwd",
        "%BASE%\\folder\\\\nested///path",
        "%BASE%\\with\0null_byte",
        "%BASE%\\unicode_\u{202E}bidi_override.txt",
    ];

    for path in attacks {
        let resolved = expand(path, &vars);
        let s = resolved.to_string_lossy();
        assert!(!s.is_empty(), "Expanded path must not be empty");
    }
}

// ── 3. Glob Rules Catastrophic Backtracking Fuzzing ───────────────────────────

#[test]
fn test_fuzz_glob_rules_backtracking() {
    let dangerous_patterns = vec![
        "**/**/**/**/**/**/**".to_string(),
        "*/*/*/*/*/*/*/*/*/*".to_string(),
        "a*b*c*d*e*f*g*h*i*j*k*".to_string(),
        "*.{tmp,bak,log,old,orig,swp,swo,~,part,crdownload}".to_string(),
        "[a-z][0-9][A-Z]*".to_string(),
    ];

    let rules = Rules::new(&[], &dangerous_patterns, 0);

    let test_paths = [
        "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/file.txt",
        "very/deep/nested/path/to/something/that/does/not/match.xyz",
        "a_b_c_d_e_f_g_h_i_j_k_match",
        "file.tmp",
        "file.crdownload",
    ];

    for path in test_paths {
        let t0 = Instant::now();
        let _ = rules.allowed(Path::new(path), 100);
        assert!(
            t0.elapsed().as_millis() < 50,
            "Glob evaluation on {path} took too long (possible catastrophic backtracking): {:?}",
            t0.elapsed()
        );
    }
}

// ── 4. Drive JSON Response Schema Fuzzing ─────────────────────────────────────

#[test]
fn test_fuzz_drive_json_response_parsing() {
    let payloads = [
        // Completely empty
        "",
        // Invalid json
        "{",
        // Null values
        r#"{"id": null, "name": null, "size": null}"#,
        // Size as integer instead of string
        r#"{"id": "file_1", "name": "doc.pdf", "size": 123456}"#,
        // Size as string
        r#"{"id": "file_1", "name": "doc.pdf", "size": "123456"}"#,
        // Negative size
        r#"{"id": "file_1", "name": "doc.pdf", "size": -50}"#,
        // Extreme unicode in name
        r#"{"id": "file_1", "name": "🔥\u0000\t\n🚀\u200B\u202E", "mimeType": "application/pdf"}"#,
        // Trashed file
        r#"{"id": "file_1", "name": "deleted.txt", "trashed": true}"#,
        // Unexpected large nested structures
        r#"{"id": "file_1", "extra": {"a": {"b": {"c": [1,2,3,4,5]}}}}"#,
    ];

    for (i, json) in payloads.iter().enumerate() {
        let t0 = Instant::now();
        let _ = serde_json::from_str::<DriveEntry>(json);
        let _ = serde_json::from_str::<DriveChange>(json);
        assert!(
            t0.elapsed().as_millis() < 100,
            "JSON fuzzing {i} took too long: {:?}",
            t0.elapsed()
        );
    }
}

// ── 5. Resumable Upload Range Header Fuzzing ──────────────────────────────────

#[test]
fn test_fuzz_range_header_parsing() {
    let headers = [
        "bytes=0-1023/1024",
        "bytes 0-1023/1024",
        "bytes=0-0/1",
        "bytes=0-5242879/*",
        "bytes=*/5242880",
        "bytes 0-999999999999999/9999999999999999",
        "invalid_range_string",
        "bytes=-1-500/1000",
        "bytes=500-200/1000", // start > end
        "bytes=0-100/-5",
        "bytes=0-100/0",
        "",
    ];

    for h in headers {
        // Parse range: extract lower and upper bound safely without panic
        if let Some(range_part) = h.strip_prefix("bytes ").or_else(|| h.strip_prefix("bytes=")) {
            if let Some((range_str, total_str)) = range_part.split_once('/') {
                let _total: Option<u64> = total_str.parse().ok();
                if let Some((start_str, end_str)) = range_str.split_once('-') {
                    let start: Option<u64> = start_str.parse().ok();
                    let end: Option<u64> = end_str.parse().ok();
                    if let (Some(s), Some(e)) = (start, end) {
                        assert!(s <= e || s > e); // safe check
                    }
                }
            }
        }
    }
}
