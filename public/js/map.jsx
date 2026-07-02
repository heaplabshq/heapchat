import { Icon } from "./icons.jsx";
// map.jsx — Photo Map: plots geotagged photos (EXIF GPS) on a Leaflet map.
const { useState: useMS, useEffect: useME, useRef: useMR } = React;

function PhotoMap({ folder, onOpenPath, onClose }) {
  const [photos, setPhotos] = useMS(null);   // null = loading
  const [scanned, setScanned] = useMS(0);
  const [err, setErr] = useMS(null);
  const elRef = useMR(null);
  const mapRef = useMR(null);

  useME(() => {
    let alive = true;
    setPhotos(null); setErr(null);
    fetch("/api/geo?path=" + encodeURIComponent(folder.path))
      .then(r => r.json())
      .then(j => { if (!alive) return; if (j.error) { setErr(j.error); return; } setScanned(j.scanned || 0); setPhotos(j.photos || []); })
      .catch(e => { if (alive) setErr(String(e.message || e)); });
    return () => { alive = false; };
  }, [folder.path]);

  useME(() => {
    if (!photos || !window.L || !elRef.current || mapRef.current) return;
    const L = window.L;
    const map = L.map(elRef.current, { worldCopyJump: true, attributionControl: true }).setView([20, 0], 2);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap contributors",
    }).addTo(map);

    const latlngs = [];
    for (const p of photos) {
      const m = L.circleMarker([p.lat, p.lng], { radius: 7, weight: 2, color: "#ffffff", fillColor: "#6366f1", fillOpacity: 1 }).addTo(map);
      const when = p.taken ? new Date(p.taken).toLocaleDateString() : "";
      m.bindPopup(
        `<div class="map-pop"><img src="/api/thumb?path=${encodeURIComponent(p.path)}&w=200" data-path="${encodeURIComponent(p.path)}" />` +
        `<div class="map-pop-name">${(p.name || "").replace(/</g, "&lt;")}</div>` +
        (when ? `<div class="map-pop-date">${when}</div>` : "") + `</div>`,
        { minWidth: 180, maxWidth: 220 }
      );
      latlngs.push([p.lat, p.lng]);
    }
    map.on("popupopen", e => {
      const img = e.popup.getElement().querySelector("img[data-path]");
      if (img && onOpenPath) { img.style.cursor = "pointer"; img.onclick = () => onOpenPath(decodeURIComponent(img.getAttribute("data-path"))); }
    });
    if (latlngs.length) map.fitBounds(latlngs, { padding: [50, 50], maxZoom: 15 });
    mapRef.current = map;
    // Leaflet needs a size recalculation once the container has laid out
    setTimeout(() => map.invalidateSize(), 60);
    return () => { map.remove(); mapRef.current = null; };
  }, [photos]);

  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="topbar">
        <button className="btn icon" title="Back to gallery" onClick={onClose}><Icon name="arrowL" size={16} /></button>
        <div className="crumb grow" style={{ gap: 8 }}>
          <Icon name="globe" size={18} style={{ color: "var(--accent)" }} />
          <span className="crumb-name">Map · {folder.name}</span>
          {photos && <span className="t-sm ink-3 none">· {photos.length} located{scanned ? ` of ${scanned} photos` : ""}</span>}
        </div>
      </div>
      <div className="content" style={{ display: "block", position: "relative", minHeight: 0 }}>
        {err ? (
          <div className="callout warn" style={{ margin: 20 }}><Icon name="alert" size={15} /><span>{err}</span></div>
        ) : photos === null ? (
          <div className="col center" style={{ height: "100%", gap: 12, color: "var(--ink-3)" }}>
            <span className="dots"><span /><span /><span /></span><span className="t-sm">Reading photo locations…</span>
          </div>
        ) : photos.length === 0 ? (
          <div className="col center" style={{ height: "100%", gap: 12, textAlign: "center", padding: 24 }}>
            <Icon name="globe" size={34} style={{ color: "var(--ink-4)", opacity: .4 }} />
            <div className="x-bold" style={{ fontSize: 15 }}>No geotagged photos here</div>
            <div className="ink-3 t-sm" style={{ maxWidth: 320 }}>None of the {scanned || 0} photo{scanned === 1 ? "" : "s"} in <b>{folder.name}</b> have GPS location data in their EXIF.</div>
          </div>
        ) : null}
        <div ref={elRef} className="photo-map" style={{ display: photos && photos.length ? "block" : "none" }} />
      </div>
    </div>
  );
}

export { PhotoMap };
