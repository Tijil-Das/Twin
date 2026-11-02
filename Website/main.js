// Twin Website - Clean utilitarian helper logic

document.addEventListener('DOMContentLoaded', () => {
  initCopyButtons();
});

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

// Download action feedback
window.downloadRelease = function(type) {
  const evt = window.event;
  const btn = evt ? evt.currentTarget : null;
  if (btn) {
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<span>Downloading ${type.toUpperCase()}...</span>`;
    setTimeout(() => {
      btn.innerHTML = originalHTML;
      window.open('https://github.com/Tijil-Das/Twin/releases', '_blank');
    }, 450);
  }
};
