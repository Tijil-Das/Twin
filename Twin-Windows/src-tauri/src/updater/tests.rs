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
