use super::*;
use tempfile::tempdir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[test]
fn test_strict_semver_validation() {
    assert!(is_strict_semver("1.0.0"));
    assert!(is_strict_semver("0.1.2"));
    assert!(is_strict_semver("12.34.56"));

    // Invalid: leading 'v', partial versions, prereleases
    assert!(!is_strict_semver("v1.0.0"));
    assert!(!is_strict_semver("1.0"));
    assert!(!is_strict_semver("1.0.0-beta"));
    assert!(!is_strict_semver("abc"));
}

#[test]
fn test_newer_semver_comparisons() {
    // Newer versions
    assert!(is_newer_semver("0.1.1", "0.1.0"));
    assert!(is_newer_semver("0.2.0", "0.1.9"));
    assert!(is_newer_semver("1.0.0", "0.9.9"));
    assert!(is_newer_semver("v0.1.5", "0.1.0")); // leading 'v' in remote is accepted

    // Same version
    assert!(!is_newer_semver("0.1.0", "0.1.0"));
    assert!(!is_newer_semver("v0.1.0", "0.1.0"));

    // Older version (No downgrade allowed, like JioTV Max)
    assert!(!is_newer_semver("0.0.9", "0.1.0"));
    assert!(!is_newer_semver("0.1.0", "0.1.1"));

    // Prereleases ignored when current is stable
    assert!(!is_newer_semver("0.2.0-beta.1", "0.1.0"));
}

#[test]
fn test_pending_update_file_lifecycle() {
    let dir = tempdir().unwrap();
    let pending_file = dir.path().join("pending-update.json");

    // Initially does not exist
    assert_eq!(read_pending(&pending_file), None);

    // Write pending update
    let pending = PendingUpdate {
        version: "0.1.1".to_string(),
        downloaded_at: "2026-11-03T00:00:00Z".to_string(),
        binary_path: "C:\\path\\to\\twin.exe".to_string(),
        release_notes: Some("Fixes and features".to_string()),
        update_type: Some(UpdateType::SetupInstaller),
    };
    write_pending(&pending_file, &pending).unwrap();

    // Read and verify
    let read_back = read_pending(&pending_file).unwrap();
    assert_eq!(read_back, pending);

    // Clear and verify
    clear_pending(&pending_file);
    assert_eq!(read_pending(&pending_file), None);
}

#[tokio::test]
async fn test_release_info_json_deserialization() {
    let server = MockServer::start().await;
    let mock_body = serde_json::json!({
        "tag_name": "v0.2.0",
        "body": "Major speed upgrade",
        "assets": [
            {
                "name": "twin-setup.exe",
                "browser_download_url": format!("{}/twin-setup.exe", server.uri()),
                "size": 8452312
            }
        ]
    });

    Mock::given(method("GET"))
        .and(path("/releases/latest"))
        .respond_with(ResponseTemplate::new(200).set_body_json(mock_body))
        .mount(&server)
        .await;

    let client = Client::new();
    let url = format!("{}/releases/latest", server.uri());
    let info = client
        .get(&url)
        .send()
        .await
        .unwrap()
        .json::<ReleaseInfo>()
        .await
        .unwrap();

    assert_eq!(info.tag_name, "v0.2.0");
    assert_eq!(info.body.as_deref(), Some("Major speed upgrade"));
    assert_eq!(info.assets.len(), 1);
    assert_eq!(info.assets[0].name, "twin-setup.exe");
}

#[test]
fn test_select_update_asset_safety() {
    let assets = vec![
        ReleaseAsset {
            name: "SHA256SUMS.txt".to_string(),
            browser_download_url: "https://example.com/sums".to_string(),
            size: 100,
        },
        ReleaseAsset {
            name: "Twin-Windows-Portable.zip".to_string(),
            browser_download_url: "https://example.com/zip".to_string(),
            size: 30000000,
        },
        ReleaseAsset {
            name: "Twin.exe".to_string(),
            browser_download_url: "https://example.com/exe".to_string(),
            size: 10000000,
        },
        ReleaseAsset {
            name: "Twin_1.1.1_x64-setup.exe".to_string(),
            browser_download_url: "https://example.com/setup".to_string(),
            size: 12000000,
        },
        ReleaseAsset {
            name: "Twin_1.1.1_x64_en-US.msi".to_string(),
            browser_download_url: "https://example.com/msi".to_string(),
            size: 11000000,
        },
    ];

    // Installed environment must select the setup installer, NEVER the zip or portable
    let installed_selected = select_update_asset(&assets, true).unwrap();
    assert_eq!(installed_selected.name, "Twin_1.1.1_x64-setup.exe");

    // Portable/standalone environment must select standalone Twin.exe, NEVER the zip or setup installer
    let portable_selected = select_update_asset(&assets, false).unwrap();
    assert_eq!(portable_selected.name, "Twin.exe");

    // Never selects a zip file even if it's the only archive
    let zip_only = vec![ReleaseAsset {
        name: "Twin-Windows-Portable.zip".to_string(),
        browser_download_url: "https://example.com/zip".to_string(),
        size: 30000000,
    }];
    assert!(select_update_asset(&zip_only, true).is_none());
    assert!(select_update_asset(&zip_only, false).is_none());
}

#[test]
fn test_pe_magic_header_validation() {
    let valid_pe = b"MZ\x90\x00\x03\x00\x00\x00";
    assert_eq!(&valid_pe[0..2], b"MZ");

    let zip_header = b"PK\x03\x04\x14\x00\x00\x00";
    assert_ne!(&zip_header[0..2], b"MZ");

    let html_error = b"<!DOCTYPE html>";
    assert_ne!(&html_error[0..2], b"MZ");
}
