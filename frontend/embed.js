/* Schedora booking widget. Add to any website:
 *   Inline:  <div data-schedora-inline="https://meet.schedora.in/meet/your-team/intro-call"></div>
 *   Popup:   <a href="https://meet.schedora.in/meet/your-team/intro-call" data-schedora-popup>Book a call</a>
 *   Script:  <script src="https://meet.schedora.in/embed.js" async></script>
 * Or call Schedora.open(url) from your own code. */
(function () {
  if (window.Schedora) return;
  var script = document.currentScript;
  var origin = script ? new URL(script.src).origin : location.origin;
  var frames = [];

  function embedUrl(url) {
    var parsed = new URL(url, origin);
    if (parsed.pathname.indexOf('/embed/') !== 0) parsed.pathname = '/embed' + parsed.pathname;
    return parsed.href;
  }

  function frame(url, height) {
    var iframe = document.createElement('iframe');
    iframe.src = embedUrl(url);
    iframe.title = 'Schedule a meeting';
    iframe.loading = 'lazy';
    iframe.style.cssText = 'width:100%;border:0;display:block;min-height:' + (height || 680) + 'px;';
    frames.push(iframe);
    return iframe;
  }

  function open(url) {
    var overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Schedule a meeting');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;';
    var panel = document.createElement('div');
    panel.style.cssText = 'background:#fff;border-radius:14px;width:100%;max-width:1000px;max-height:92vh;overflow:auto;position:relative;';
    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.style.cssText = 'position:absolute;top:8px;right:12px;font-size:28px;line-height:1;border:0;background:none;cursor:pointer;color:#182e28;';
    var opener = document.activeElement;
    function dismiss() { overlay.remove(); document.removeEventListener('keydown', onKey); if (opener && opener.focus) opener.focus(); }
    function onKey(event) { if (event.key === 'Escape') dismiss(); }
    close.addEventListener('click', dismiss);
    overlay.addEventListener('click', function (event) { if (event.target === overlay) dismiss(); });
    document.addEventListener('keydown', onKey);
    panel.appendChild(close);
    panel.appendChild(frame(url, 640));
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    close.focus();
  }

  // The booking page reports its height so inline frames grow without inner scrollbars.
  window.addEventListener('message', function (event) {
    if (event.origin !== origin || !event.data || event.data.type !== 'schedora:height') return;
    frames.forEach(function (iframe) { if (iframe.contentWindow === event.source) iframe.style.height = Math.max(400, event.data.height + 24) + 'px'; });
  });

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-schedora-inline]'), function (element) {
      if (element.dataset.schedoraReady) return;
      element.dataset.schedoraReady = '1';
      element.appendChild(frame(element.getAttribute('data-schedora-inline')));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-schedora-popup]'), function (element) {
      if (element.dataset.schedoraReady) return;
      element.dataset.schedoraReady = '1';
      element.addEventListener('click', function (event) { event.preventDefault(); open(element.getAttribute('href') || element.getAttribute('data-schedora-popup')); });
    });
  }

  window.Schedora = { open: open, init: init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
