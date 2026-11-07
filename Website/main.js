// Twin Website - Direct Download, Live GitHub Release Resolver & Utility Logic
// Inspired by JioTV Max's resilient release architecture

const GITHUB_REPO = 'Tijil-Das/Twin';
const DEFAULT_VERSION = 'v1.1.0';
const CACHE_KEY = '__twin_release_cache__';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15-minute cache to prevent GitHub rate-limiting (60 req/hr)

// Default static fallback URLs & SHA-256 hashes (v1.1.0 baseline)
const releaseAssets = {
  exe: {
    url: 'https://github.com/Tijil-Das/Twin/releases/download/v1.1.0/Twin_1.1.0_x64-setup.exe',
    name: 'Twin_1.1.0_x64-setup.exe',
    sha256: '2359bcd289371f818a2a3096e5bb317c7c0c215176d7eccb4a87f5cdb7085dab'
  },
  msi: {
    url: 'https://github.com/Tijil-Das/Twin/releases/download/v1.1.0/Twin_1.1.0_x64_en-US.msi',
    name: 'Twin_1.1.0_x64_en-US.msi',
    sha256: '78970db77fa8c68b3bd81035bddf9c31e96c03c3d2f89a46e126b84a97d55ce7'
  },
  zip: {
    url: 'https://github.com/Tijil-Das/Twin/releases/download/v1.1.0/Twin-Windows-Portable.zip',
    name: 'Twin-Windows-Portable.zip',
    sha256: '887cbfdda7368c302e96df61c9a8d54642a749a62c9ab2637bb422695bf584e3'
  },
  bin: {
    url: 'https://github.com/Tijil-Das/Twin/releases/download/v1.1.0/Twin.exe',
    name: 'Twin.exe',
    sha256: 'eb9b5a40b366b1ee8d683da899c95912fb77c59da512a3aac11dcc40649fa9b3'
  }
};

let currentVersion = DEFAULT_VERSION;
let isResolvingRelease = false;
let resolvePromise = null;

// Cache storage helpers
function loadCachedRelease() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.timestamp > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function saveCachedRelease(data) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        timestamp: Date.now(),
        data
      })
    );
  } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
  initCopyButtons();
  initDownloadTriggers();
  initPackageHover();

  // 1. Immediately apply cached data if present to avoid any visual flicker
  const cached = loadCachedRelease();
  if (cached && cached.tag) {
    currentVersion = cached.tag;
    if (cached.assets) {
      Object.assign(releaseAssets, cached.assets);
    }
  }
  applyReleaseData();

  // 2. Fetch live release from GitHub in the background
  resolveLatestRelease();
});

// Clean in-page toast notification (JioTV Max design standard)
function showToast(message) {
  let toast = document.getElementById('site-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'site-toast';
    toast.style.position = 'fixed';
    toast.style.bottom = '28px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%) translateY(16px)';
    toast.style.background = '#11131B';
    toast.style.color = '#F3F4F6';
    toast.style.border = '1px solid rgba(255, 255, 255, 0.16)';
    toast.style.padding = '10px 20px';
    toast.style.borderRadius = '8px';
    toast.style.fontSize = '13.5px';
    toast.style.fontWeight = '500';
    toast.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.6)';
    toast.style.opacity = '0';
    toast.style.transition = 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)';
    toast.style.zIndex = '9999';
    toast.style.pointerEvents = 'none';
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });

  if (toast._timer) clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(16px)';
  }, 3500);
}

// Trigger direct browser file download without redirecting
function triggerDirectDownload(url, filename) {
  if (!url) return;
  const link = document.createElement('a');
  link.href = url;
  if (filename) link.setAttribute('download', filename);
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Synchronize all DOM elements with the current version and release assets
function applyReleaseData() {
  const cleanVersion = currentVersion.replace(/^v/i, '');

  // 1. Update version pills & spans (.app-version-tag)
  document.querySelectorAll('.app-version-tag').forEach(el => {
    if (el.getAttribute('data-format') === 'raw') {
      el.textContent = cleanVersion;
    } else {
      el.textContent = currentVersion;
    }
  });

  // 2. Update hero badge tag
  const heroPill = document.querySelector('.hero-pill-badge');
  if (heroPill) {
    heroPill.textContent = `Twin ${currentVersion} · Windows 10 & 11 (64-bit)`;
  }

  // 3. Update download buttons text
  document.querySelectorAll('.btn-download-text').forEach(el => {
    const btnType = el.getAttribute('data-btn-type');
    if (btnType === 'hero') {
      el.textContent = `Download Twin ${currentVersion}`;
    } else if (btnType === 'nav') {
      el.textContent = `Download ${currentVersion}`;
    } else {
      el.textContent = `Download ${currentVersion}`;
    }
  });

  // 4. Update all download trigger links (href and download attributes)
  document.querySelectorAll('.download-trigger').forEach(el => {
    const type = el.getAttribute('data-type') || 'exe';
    const target = releaseAssets[type] || releaseAssets.exe;
    el.setAttribute('href', target.url);
    el.setAttribute('download', target.name);
  });

  // 5. Update SHA-256 hash
  updateHashDisplay('exe');
}

// Update the SHA-256 code block and copy button
function updateHashDisplay(type = 'exe') {
  const asset = releaseAssets[type] || releaseAssets.exe;
  const shaCode = document.getElementById('sha256-hash');
  const shaCopy = document.getElementById('sha256-copy-btn');
  const labelEl = document.querySelector('.hash-label');

  const labelMap = {
    exe: 'SHA-256 (Setup EXE):',
    msi: 'SHA-256 (MSI):',
    zip: 'SHA-256 (Portable ZIP):',
    bin: 'SHA-256 (Standalone EXE):'
  };

  if (labelEl && labelMap[type]) {
    labelEl.textContent = labelMap[type];
  }
  if (shaCode && asset && asset.sha256) {
    shaCode.textContent = asset.sha256;
  }
  if (shaCopy && asset && asset.sha256) {
    shaCopy.setAttribute('data-copy', asset.sha256);
  }
}

// Dynamically resolve latest release from GitHub API (like JioTV Max)
async function resolveLatestRelease() {
  if (isResolvingRelease) return resolvePromise;
  isResolvingRelease = true;

  resolvePromise = (async () => {
    try {
      let res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github.v3+json' }
      });

      // Fallback if latest returns 404
      if (res.status === 404) {
        res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=1`, {
          headers: { Accept: 'application/vnd.github.v3+json' }
        });
      }

      if (!res.ok) {
        console.warn(`GitHub API returned status ${res.status}, using bundled fallback`);
        return currentVersion;
      }

      let data = await res.json();
      if (Array.isArray(data)) data = data[0];
      if (!data) return currentVersion;

      const tag = data.tag_name || DEFAULT_VERSION;
      currentVersion = tag;
      const assets = Array.isArray(data.assets) ? data.assets : [];

      // Find respective assets
      const exeAsset = assets.find(a =>
        a.name.endsWith('-setup.exe') ||
        (a.name.endsWith('.exe') && a.name.toLowerCase().includes('setup'))
      );
      const msiAsset = assets.find(a => a.name.endsWith('.msi'));
      const zipAsset = assets.find(a => a.name.endsWith('.zip'));
      const binAsset = assets.find(a =>
        a.name.endsWith('.exe') && !a.name.toLowerCase().includes('setup')
      );
      const sumsAsset = assets.find(a => a.name.toLowerCase() === 'sha256sums.txt');

      if (exeAsset) {
        releaseAssets.exe.url = exeAsset.browser_download_url;
        releaseAssets.exe.name = exeAsset.name;
      }
      if (msiAsset) {
        releaseAssets.msi.url = msiAsset.browser_download_url;
        releaseAssets.msi.name = msiAsset.name;
      }
      if (zipAsset) {
        releaseAssets.zip.url = zipAsset.browser_download_url;
        releaseAssets.zip.name = zipAsset.name;
      }
      if (binAsset) {
        releaseAssets.bin.url = binAsset.browser_download_url;
        releaseAssets.bin.name = binAsset.name;
      }

      // Fetch SHA256SUMS.txt if available
      if (sumsAsset && sumsAsset.browser_download_url) {
        try {
          const sumsRes = await fetch(sumsAsset.browser_download_url);
          if (sumsRes.ok) {
            const sumsText = await sumsRes.text();
            sumsText.split(/\r?\n/).forEach(line => {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 2 && /^[a-f0-9]{64}$/i.test(parts[0])) {
                const hash = parts[0].toLowerCase();
                const fname = parts[1].replace(/^\*/, '');
                for (const key of Object.keys(releaseAssets)) {
                  if (releaseAssets[key].name === fname) {
                    releaseAssets[key].sha256 = hash;
                  }
                }
              }
            });
          }
        } catch (e) {
          console.debug('Failed to load SHA256SUMS.txt:', e);
        }
      }

      applyReleaseData();

      saveCachedRelease({
        tag: currentVersion,
        assets: releaseAssets
      });
    } catch (err) {
      console.warn('Could not query GitHub releases API, using bundled fallback:', err);
    } finally {
      isResolvingRelease = false;
    }

    return currentVersion;
  })();

  return resolvePromise;
}

// Download action called on button click (awaits in-flight resolution like JioTV Max)
function initDownloadTriggers() {
  document.querySelectorAll('.download-trigger').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const type = btn.getAttribute('data-type') || 'exe';

      showToast(`Downloading Twin ${currentVersion}...`);

      if (isResolvingRelease && resolvePromise) {
        try {
          await resolvePromise;
        } catch {}
      }

      const target = releaseAssets[type] || releaseAssets.exe;
      triggerDirectDownload(target.url, target.name);
    });
  });
}

// Interactive package hover updates SHA-256 box dynamically
function initPackageHover() {
  document.querySelectorAll('.download-btn-group .download-trigger').forEach(btn => {
    const type = btn.getAttribute('data-type');
    if (type) {
      btn.addEventListener('mouseenter', () => updateHashDisplay(type));
      btn.addEventListener('focus', () => updateHashDisplay(type));
    }
  });

  const btnGroup = document.querySelector('.download-btn-group');
  if (btnGroup) {
    btnGroup.addEventListener('mouseleave', () => updateHashDisplay('exe'));
  }
}

// Legacy global helper
window.downloadRelease = function(type, event) {
  if (event && event.preventDefault) {
    event.preventDefault();
  }
  showToast(`Downloading Twin ${currentVersion}...`);
  void (async () => {
    if (isResolvingRelease && resolvePromise) {
      try {
        await resolvePromise;
      } catch {}
    }
    const asset = releaseAssets[type] || releaseAssets.exe;
    triggerDirectDownload(asset.url, asset.name);
  })();
};

// Copy SHA-256 Hash
function initCopyButtons() {
  const copyBtns = document.querySelectorAll('[data-copy]');
  copyBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const textToCopy = btn.getAttribute('data-copy');
      if (textToCopy) {
        const copySuccess = () => {
          const originalText = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => {
            btn.textContent = originalText;
          }, 1800);
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(textToCopy).then(copySuccess).catch(() => {
            fallbackCopy(textToCopy, copySuccess);
          });
        } else {
          fallbackCopy(textToCopy, copySuccess);
        }
      }
    });
  });
}

function fallbackCopy(text, callback) {
  const temp = document.createElement('textarea');
  temp.value = text;
  temp.style.position = 'fixed';
  temp.style.opacity = '0';
  document.body.appendChild(temp);
  temp.select();
  document.execCommand('copy');
  document.body.removeChild(temp);
  if (callback) callback();
}
