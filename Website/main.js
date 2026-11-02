// Twin Website Interactive Logic - Clean, fast, zero unnecessary overhead

document.addEventListener('DOMContentLoaded', () => {
  initFaqAccordion();
  initCopyButtons();
});

// FAQ Accordion
function initFaqAccordion() {
  const questions = document.querySelectorAll('.faq-question');
  questions.forEach(question => {
    question.addEventListener('click', () => {
      const card = question.closest('.faq-card');
      if (card) {
        card.classList.toggle('open');
      }
    });
  });
}

// Copy SHA-256 Hash Helper
function initCopyButtons() {
  const copyBtns = document.querySelectorAll('[data-copy]');
  copyBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const textToCopy = btn.getAttribute('data-copy');
      if (textToCopy) {
        navigator.clipboard.writeText(textToCopy).then(() => {
          const originalHTML = btn.innerHTML;
          btn.innerHTML = `<span>Copied to clipboard!</span>`;
          setTimeout(() => {
            btn.innerHTML = originalHTML;
          }, 2000);
        }).catch(() => {
          // Fallback if clipboard API is restricted
          const temp = document.createElement('textarea');
          temp.value = textToCopy;
          document.body.appendChild(temp);
          temp.select();
          document.execCommand('copy');
          document.body.removeChild(temp);
          const originalHTML = btn.innerHTML;
          btn.innerHTML = `<span>Copied!</span>`;
          setTimeout(() => {
            btn.innerHTML = originalHTML;
          }, 2000);
        });
      }
    });
  });
}

// Download release notification
window.downloadRelease = function(type) {
  const btn = event?.currentTarget;
  if (btn) {
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<span>Preparing ${type.toUpperCase()}...</span>`;
    setTimeout(() => {
      btn.innerHTML = originalHTML;
    }, 2200);
  }
};
