/* MapLibre-/Canvas-Attrappe für die Suiten (ohne Browser).
 *
 * Seit die Fahrzeugpillen Kartenebenen sind (GeoJSON-Quelle + Symbolebene mit einem gerasterten Bild
 * je Linie), braucht der Harness das Stück MapLibre-API, das live.js dafür benutzt — und ein Canvas-2D,
 * das mitschreibt, was gezeichnet wurde. Bewusst streng an den zwei Stellen, die im Browser schon
 * einmal gebrochen sind:
 *   - addImage nimmt nur ImageData-artige Objekte ({width, height, data}); ein <canvas> wirft wie in
 *     der echten MapLibre-Fassung „mismatched image size".
 *   - addImage auf einen schon vergebenen Namen wirft (MapLibre: "An image named … already exists").
 * queryRenderedFeatures rechnet über map.project() und die Bildgröße, damit ein Tipp auf eine Pille
 * wirklich auf DIESER Pille landet.
 */
'use strict';

class Path2D { constructor(d) { this.d = d; } }

// Canvas 2D: jede Zeichenoperation landet mit dem gerade gesetzten Stil in ops.
function canvas2d(canvasEl) {
  const ops = [];
  const st = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif',
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0, textAlign: 'start', textBaseline: 'alphabetic' };
  const stack = [];
  const c = {
    ops,
    save() { stack.push(Object.assign({}, st)); },
    restore() { if (stack.length) Object.assign(st, stack.pop()); },
    scale() {}, translate() {}, setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, closePath() {},
    clearRect() {}, strokeRect() {},
    fillRect() { ops.push({ op: 'fillRect', fillStyle: st.fillStyle }); },
    fill(p) { ops.push({ op: 'fill', fillStyle: st.fillStyle, shadow: st.shadowColor, path: p && p.d }); },
    stroke() { ops.push({ op: 'stroke', strokeStyle: st.strokeStyle, lineWidth: st.lineWidth }); },
    fillText(t) { ops.push({ op: 'text', text: String(t), font: st.font, fillStyle: st.fillStyle }); },
    measureText(t) { const px = parseFloat((String(st.font).match(/([\d.]+)px/) || [])[1]) || 10; return { width: String(t).length * px * 0.62 }; },
    getImageData(x, y, w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)), ops: ops.slice() };
    },
  };
  for (const k of Object.keys(st)) {
    Object.defineProperty(c, k, { get: () => st[k], set: v => { st[k] = v; }, enumerable: true });
  }
  void canvasEl;
  return c;
}

// Ergänzt eine Karten-Attrappe um Quellen, Ebenen, Bilder, Ebenen-Ereignisse und Trefferabfrage.
function installGl(map, opts = {}) {
  const style = opts.style || { sources: {}, layers: [] };
  const images = new Map();
  const layerHandlers = {};
  const canvas = { style: {} };
  const gl = { style, images, layerHandlers, canvas, setDataCalls: 0 };

  map.isStyleLoaded = () => true;
  map.getStyle = map.getStyle || (() => style);
  map.getSource = id => style.sources[id];
  map.addSource = (id, s) => {
    if (style.sources[id]) throw new Error('There is already a source with ID "' + id + '".');
    const src = Object.assign({}, s);
    src.setData = d => { src.data = d; gl.setDataCalls++; return src; };
    style.sources[id] = src;
  };
  map.getLayer = id => style.layers.find(l => l.id === id);
  map.addLayer = (l, before) => {
    if (map.getLayer(l.id)) throw new Error('Layer "' + l.id + '" already exists on this map.');
    const i = before ? style.layers.findIndex(x => x.id === before) : -1;
    style.layers.splice(i < 0 ? style.layers.length : i, 0, l);
  };
  map.getLayoutProperty = (id, k) => { const l = map.getLayer(id); return l && l.layout ? l.layout[k] : undefined; };
  map.setLayoutProperty = (id, k, v) => {
    const l = map.getLayer(id); if (!l) throw new Error('no layer ' + id);
    l.layout = Object.assign({}, l.layout, { [k]: v });
  };
  const checkImage = (id, img) => {
    if (!img || typeof img.width !== 'number' || typeof img.height !== 'number' || !img.data ||
        img.data.length !== img.width * img.height * 4) throw new Error('mismatched image size for ' + id);
  };
  map.hasImage = id => images.has(id);
  map.getImage = id => images.get(id) || null;
  map.addImage = (id, img, o) => {
    if (images.has(id)) throw new Error('An image named "' + id + '" already exists.');
    checkImage(id, img);
    images.set(id, { data: img, pixelRatio: (o && o.pixelRatio) || 1 });
  };
  map.updateImage = (id, img) => {
    const old = images.get(id); if (!old) throw new Error('no image ' + id);
    checkImage(id, img);
    if (old.data.width !== img.width || old.data.height !== img.height) throw new Error('mismatched image size for ' + id);
    images.set(id, { data: img, pixelRatio: old.pixelRatio });
  };
  map.removeImage = id => { images.delete(id); };
  map.getCanvas = () => canvas;
  const origOn = map.on;
  map.on = function (ev, a, b) {
    if (typeof a === 'string') { (layerHandlers[ev + ':' + a] = layerHandlers[ev + ':' + a] || []).push(b); return this; }
    return origOn ? origOn.call(this, ev, a) : this;
  };

  // Treffer: Pillen über ihre Bildgröße (CSS-Pixel = Gerätepixel / pixelRatio), Kreise über den Radius.
  const radius = (layer, f) => {
    const r = layer.paint && layer.paint['circle-radius'];
    if (Array.isArray(r) && r[0] === 'case') return f.properties[r[1][1]] ? r[2] : r[3];
    return typeof r === 'number' ? r : 6;
  };
  map.queryRenderedFeatures = (point, o) => {
    const px = Array.isArray(point) ? point[0] : point && point.x;
    const py = Array.isArray(point) ? point[1] : point && point.y;
    const out = [];
    for (const id of (o && o.layers) || style.layers.map(l => l.id)) {
      const layer = map.getLayer(id);
      if (!layer) continue;
      if (layer.layout && layer.layout.visibility === 'none') continue;
      const src = style.sources[layer.source];
      const feats = (src && src.data && src.data.features) || [];
      for (const f of feats) {
        const p = map.project(f.geometry.coordinates);
        let hit = false;
        if (layer.type === 'symbol' && layer.layout && layer.layout['icon-image']) {
          const im = images.get(f.properties.pillimg);
          if (!im) continue;                         // ohne Bild zeichnet MapLibre nichts
          const hw = im.data.width / im.pixelRatio / 2, hh = im.data.height / im.pixelRatio / 2;
          hit = Math.abs(px - p.x) <= hw && Math.abs(py - p.y) <= hh;
        } else if (layer.type === 'symbol') {
          hit = Math.abs(px - p.x) <= 4 && Math.abs(py - p.y) <= 5;
        } else if (layer.type === 'circle') {
          hit = Math.hypot(px - p.x, py - p.y) <= radius(layer, f);
        }
        if (hit) out.push({ type: 'Feature', layer: { id }, source: layer.source, geometry: f.geometry, properties: f.properties });
      }
    }
    return out;
  };
  // Ein Tipp an die Bildschirmposition eines Features
  gl.tapAt = (handlers, lngLat) => {
    const p = map.project(lngLat);
    const fn = handlers.click;
    if (typeof fn === 'function') fn({ point: { x: p.x, y: p.y }, lngLat });
    return p;
  };
  gl.features = id => ((style.sources[id] && style.sources[id].data && style.sources[id].data.features) || []);
  return gl;
}

module.exports = { canvas2d, installGl, Path2D };
