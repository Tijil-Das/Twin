// Twin Website - Interactive Visuals & Simulation Logic

document.addEventListener('DOMContentLoaded', () => {
  initGovernorSimulator();
  initChunkStreamTicker();
  initFaqAccordion();
  initCopyButtons();
});

// Interactive Governor Simulation Widget
function initGovernorSimulator() {
  const simBtn = document.getElementById('gov-sim-btn');
  const cpuVal = document.getElementById('gov-cpu-val');
  const meterFill = document.getElementById('gov-meter-fill');
  const statusTag = document.getElementById('gov-status-tag');

  if (!simBtn || !cpuVal || !meterFill || !statusTag) return;

  let isSpiked = false;

  simBtn.addEventListener('click', () => {
    isSpiked = !isSpiked;

    if (isSpiked) {
      // Simulate heavy host CPU load
      cpuVal.textContent = '84%';
      meterFill.style.width = '84%';
      meterFill.classList.add('hot');
      statusTag.textContent = 'PAUSED TO YIELD CPU';
      statusTag.className = 'meter-status-tag paused';
      simBtn.innerHTML = '<span>Restore Normal Load (18%)</span>';
    } else {
      // Restore normal operating load
      cpuVal.textContent = '18%';
      meterFill.style.width = '22%';
      meterFill.classList.remove('hot');
      statusTag.textContent = 'ACTIVE · 14.8 MB/s';
      statusTag.className = 'meter-status-tag';
      simBtn.innerHTML = '<span>Simulate Spike (&gt;70% CPU)</span>';
    }
  });
}

// Live Chunk Stream Progress Ticker in Pillar 1
function initChunkStreamTicker() {
  const streamFill2 = document.getElementById('stream-fill-2');
  const streamRate2 = document.getElementById('stream-rate-2');
  const streamFill3 = document.getElementById('stream-fill-3');
  const streamRate3 = document.getElementById('stream-rate-3');

  if (!streamFill2 || !streamFill3) return;

  let p2 = 78;
  let p3 = 44;

  setInterval(() => {
    p2 += 1.2;
    if (p2 > 100) p2 = 12;
    streamFill2.style.width = `${Math.min(100, p2.toFixed(0))}%`;
    if (streamRate2) {
      streamRate2.textContent = `${p2 >= 100 ? 'Done ✓' : `${p2.toFixed(0)}% · 4.4 MB/s`}`;
    }

    p3 += 0.8;
    if (p3 > 100) p3 = 5;
    streamFill3.style.width = `${Math.min(100, p3.toFixed(0))}%`;
    if (streamRate3) {
      streamRate3.textContent = `${p3 >= 100 ? 'Done ✓' : `${p3.toFixed(0)}% · 5.1 MB/s`}`;
    }
  }, 350);
}

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
          btn.innerHTML = `<span>Copied!</span>`;
          setTimeout(() => {
            btn.innerHTML = originalHTML;
          }, 2000);
        }).catch(() => {
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

// Download action helper
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
