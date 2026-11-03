// Twin Website - Direct Download & Utility Logic

const GITHUB_REPO = 'Tijil-Das/Twin';

// Default static fallback URLs (v1.0.0)
const releaseAssets = {
  exe: {
    url: 'https://github.com/Tijil-Das/Twin/releases/download/v1.0.0/Twin_1.0.0_x64-setup.exe',
    name: 'Twin_1.0.0_x64-setup.exe',
    sha256: '72e3a3a6323e910e9c032c71a073bd3b3e0fbe7100ec0698f8ab45e49e8eef5c'
  },
  msi: {
    url: 'https://github.com/Tijil-Das/Twin/releases/download/v1.0.0/Twin_1.0.0_x64_en-US.msi',
    name: 'Twin_1.0.0_x64_en-US.msi',
    sha256: 'bd681d5b8d54ab6c4efbe89b85e65d0d072e273fe0ae6834ae58b798e7d3890c'
  },
  zip: {
    url: 'https://github.com/Tijil-Das/Twin/releases/download/v1.0.0/Twin-Windows-Portable.zip',
    name: 'Twin-Windows-Portable.zip',
    sha256: 'fd69b10d4c6da7ac300d6dccab36a97c323a097aea6717a62d361da28bb7fa17'
  },
  bin: {
    url: 'https://github.com/Tijil-Das/Twin/releases/download/v1.0.0/Twin.exe',
    name: 'Twin.exe',
    sha256: 'b215161d368676223998ed59076ec5f3620d7819ccbb51f2c4c457911c5e934e'
  }
};

let currentVersion = 'v1.0.0';

document.addEventListener('DOMContentLoaded', () => {
  initCopyButtons();
  resolveLatestRelease();
});

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

// Download action called on button click
window.downloadRelease = function(type, event) {
  if (event && event.preventDefault) {
    event.preventDefault();
  }
  const asset = releaseAssets[type] || releaseAssets.exe;
  const evt = event || window.event;
  const btn = evt ? evt.currentTarget : null;

  if (btn) {
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<span>Starting download...</span>`;
    setTimeout(() => {
      btn.innerHTML = originalHTML;
    }, 1500);
  }

  triggerDirectDownload(asset.url, asset.name);
};

// Dynamically resolve latest release from GitHub API (like JioTV Max)
async function resolveLatestRelease() {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github.v3+json' }
    });
    if (!res.ok) return;

    const data = await res.json();
    const tag = data.tag_name || 'v1.0.0';
    currentVersion = tag;
    const assets = data.assets || [];

    // Find respective assets
    const exeAsset = assets.find(a => a.name.endsWith('-setup.exe') || (a.name.endsWith('.exe') && a.name.includes('setup')));
    const msiAsset = assets.find(a => a.name.endsWith('.msi'));
    const zipAsset = assets.find(a => a.name.endsWith('.zip'));
    const binAsset = assets.find(a => a.name.endsWith('.exe') && !a.name.includes('setup'));

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

    // Update all direct download DOM elements
    document.querySelectorAll('.download-trigger').forEach(el => {
      const type = el.getAttribute('data-type') || 'exe';
      const target = releaseAssets[type] || releaseAssets.exe;
      el.setAttribute('href', target.url);
      el.setAttribute('download', target.name);
    });

    // Update version strings in badges
    document.querySelectorAll('.version-pill').forEach(el => {
      if (el.textContent.includes('v') || el.textContent.includes('1.')) {
        el.textContent = currentVersion;
      }
    });

  } catch (err) {
    console.debug('Using bundled fallback release assets:', err);
  }
}

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
