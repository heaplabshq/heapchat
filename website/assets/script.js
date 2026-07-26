// Heap Chat showcase site — tiny, dependency-free enhancements only.
(function () {
  "use strict";

  /* ---- download telemetry ----------------------------------------------------------------
     Reports a click on any release-download button into the shared heaplabs collector
     (https://github.com/heaplabshq/heaplabs-telemetry — one Worker + D1 for every heaplabs app,
     partitioned by an `app` field). "heapchat-site" has to be in that repo's KNOWN_APPS
     allowlist or ingestion rejects this with 400 "unknown app".

     Measures CLICKS, not completed downloads — the browser never tells the page whether the
     transfer finished, so treat this as download intent. GitHub's own per-asset download_count
     (gh api repos/heaplabshq/heapchat/releases/latest --jq '.assets[]|.name,.download_count') is
     the ground truth for completed downloads, and counts people who never touched this site;
     what this adds is which platform button gets pressed here, and site-vs-direct attribution.

     Privacy: follows heapedit's more conservative choice over heapcode-vscode's — the id is
     generated per page load and never persisted (no localStorage, no cookie), so no cross-visit
     identifier exists anywhere. Sends only the asset filename, a coarse OS family parsed from a
     UA string the page can already read, and a timestamp. No referrer, no IP handling, no
     fingerprinting. Nothing here may ever carry anything user-identifying.
     ------------------------------------------------------------------------------------------ */
  var TELEMETRY_ENDPOINT = "https://heaplabs-telemetry.y5ghjsdc4n.workers.dev/v1/events";
  var TELEMETRY_APP = "heapchat-site";

  var anonId = (window.crypto && window.crypto.randomUUID)
    ? window.crypto.randomUUID()
    : Date.now() + "-" + Math.random().toString(36).slice(2);

  // same coarseness as the other heaplabs clients — OS family only, nothing more specific
  function detectOs() {
    var ua = navigator.userAgent || "";
    if (/Mac OS X/.test(ua)) return "darwin";
    if (/Windows/.test(ua)) return "windows";
    if (/Linux|Android/.test(ua)) return "linux";
    if (/iPhone|iPad|iPod/.test(ua)) return "ios";
    return undefined;
  }

  // Delegated + capture so it still fires when the click lands on the <svg> icon inside the <a>,
  // and matched on the href rather than a class list so any download button added later is
  // covered without touching this.
  document.addEventListener("click", function (e) {
    var link = e.target && e.target.closest && e.target.closest('a[href*="/releases/latest/download/"]');
    if (!link) return;
    var href = link.getAttribute("href") || "";
    var asset = href.split("/").pop() || "unknown";
    try {
      // keepalive matters here: this click navigates the tab to GitHub immediately, and without
      // it the browser cancels the in-flight POST before it lands.
      fetch(TELEMETRY_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          app: TELEMETRY_APP,
          anonId: anonId,
          os: detectOs(),
          events: [{ name: "site.download.click", ts: Date.now(), meta: { asset: asset } }]
        })
      }).catch(function () { /* telemetry must never interfere with the download */ });
    } catch (_) { /* same */ }
  }, true);

  // mobile nav toggle
  var burger = document.getElementById("nav-burger");
  var mobileMenu = document.getElementById("mobile-menu");
  if (burger && mobileMenu) {
    function closeMenu() {
      burger.setAttribute("aria-expanded", "false");
      mobileMenu.classList.remove("open");
    }
    burger.addEventListener("click", function () {
      var isOpen = mobileMenu.classList.toggle("open");
      burger.setAttribute("aria-expanded", String(isOpen));
    });
    mobileMenu.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", closeMenu);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeMenu();
    });
  }

  // click-to-zoom on screenshots (mockup hero + showcase rows)
  var shots = document.querySelectorAll(".mockup img, .shot-frame img");
  if (!shots.length) return;

  var overlay = document.createElement("div");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.cssText = [
    "position:fixed", "inset:0", "z-index:200", "display:none",
    "align-items:center", "justify-content:center", "padding:32px",
    "background:rgba(20,16,10,0.72)", "cursor:zoom-out",
  ].join(";");
  var img = document.createElement("img");
  img.style.cssText = "max-width:min(1400px,94vw);max-height:92vh;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,0.5);";
  overlay.appendChild(img);
  document.body.appendChild(overlay);

  function close() {
    overlay.style.display = "none";
    overlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });

  shots.forEach(function (el) {
    el.style.cursor = "zoom-in";
    el.addEventListener("click", function () {
      img.src = el.src;
      img.alt = el.alt || "";
      overlay.style.display = "flex";
      overlay.setAttribute("aria-hidden", "false");
      document.body.style.overflow = "hidden";
    });
  });
})();
