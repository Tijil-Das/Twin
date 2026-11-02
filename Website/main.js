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
        navigator.clipboard.writeText(textToCopy).then(() => {
          const originalText = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => {
            btn.textContent = originalText;
          }, 1800);
        }).catch(() => {
          const temp = document.createElement('textarea');
          temp.value = textToCopy;
          document.body.appendChild(temp);
          temp.select();
          document.execCommand('copy');
          document.body.removeChild(temp);
          const originalText = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => {
            btn.textContent = originalText;
          }, 1800);
        });
      }
    });
  });
}

// Download action feedback
window.downloadRelease = function(type) {
  const btn = event?.currentTarget;
  if (btn) {
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<span>Starting ${type.toUpperCase()}...</span>`;
    setTimeout(() => {
      btn.innerHTML = originalHTML;
    }, 2000);
  }
};
