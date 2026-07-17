// Heap Chat showcase site — tiny, dependency-free enhancements only.
(function () {
  "use strict";

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
