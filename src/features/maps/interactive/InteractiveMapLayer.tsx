'use client';

/**
 * Map-side half of Interactive annotation mode. Renders nothing itself; it
 * drives Leaflet while the mode is active:
 *  - dims everything outside the AOI and frames the AOI in gold, so the mode
 *    (and the workspace) is unmistakable;
 *  - draws the draft masks on their own canvas pane, restyled by the
 *    completeness filter.
 * Layers are tracked in refs and diffed by mask id, so streaming thousands of
 * masks doesn't rebuild the world per batch.
 */
import { useEffect, useRef } from 'react';
import type L from 'leaflet';
import { getMapManager } from '../MapManager';
import { useMapStore } from '@/stores/mapStore';
import { MC } from '../mapColors';
import { useInteractiveStore, visibleMasks } from './store';
import { isFiltering, selectMasks } from './selection';
import { boxGeometry, hitTest } from './geo';
import { bboxHectares } from './geo';
import type { DraftMask, MapFilter } from './types';

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

// Pointer cursors that say what the next click will do: a green + or a red −.
const cursorSvg = (glyph: string, color: string) =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'><circle cx='14' cy='14' r='10' fill='none' stroke='#242c20' stroke-width='5'/><circle cx='14' cy='14' r='10' fill='rgba(255,255,255,0.15)' stroke='white' stroke-width='2.5'/><path d='${glyph}' stroke='${color}' stroke-width='3' stroke-linecap='round'/></svg>`,
  )}") 14 14, crosshair`;
const CURSOR_INCLUDE = cursorSvg('M14 8v12M8 14h12', '#3fbf5a');
const CURSOR_EXCLUDE = cursorSvg('M8 14h12', '#e5484d');

const PANE_SCRIM = 'af-interactive-scrim';
const PANE_MASKS = 'af-interactive-masks';
const PANE_FRAME = 'af-interactive-frame';
const SCRIM_FILL = 'rgba(36,44,32,0.62)'; // MC.navBg at 62%

function matchesFilter(m: DraftMask, f: MapFilter): boolean {
  if (f === 'all') return true;
  if (f === 'labelled') return !!m.classId;
  if (f === 'unlabelled') return !m.classId;
  return m.flags.length > 0;
}

// Mask outlines must read on any imagery (green canopy, bare soil, shadow), so each
// mask is a bright heavy line over a dark casing. Colours are data colours here:
// brighter than the muted UI gold, which disappears on drone imagery.
const COLOR_UNLABELLED = '#f5c451';

interface StyleCtx {
  colors: Map<string, string>;
  /** Ids matching every active filter; null when nothing is being filtered. */
  selected: Set<string> | null;
  /** Masks clicked individually: they get a white ring so the one you clicked is unmistakable. */
  picked: Set<string>;
}

function styleFor(m: DraftMask, filter: MapFilter, ctx: StyleCtx): L.PathOptions {
  if (ctx.picked.has(m.id)) return { color: '#ffffff', weight: 5, opacity: 1, fillColor: '#ffffff', fillOpacity: 0.3 };
  if (m.source === 'manual') {
    // Reference objects: the user's own picks — heaviest of all.
    return { color: COLOR_UNLABELLED, weight: 5, opacity: 1, fillColor: COLOR_UNLABELLED, fillOpacity: 0.3 };
  }
  const grouped = m.clusterId !== null ? ctx.colors.get(m.clusterId) : undefined;
  const dimmed = ctx.selected !== null && !ctx.selected.has(m.id);
  const on = matchesFilter(m, filter) && !dimmed;
  const flagged = m.flags.length > 0;
  // Groups colour the map; ungrouped masks keep the status colours.
  const color = grouped ?? (flagged ? '#ff7a59' : m.classId ? '#8bd17c' : COLOR_UNLABELLED);
  const focused = ctx.selected !== null && ctx.selected.has(m.id);
  return {
    color,
    weight: on ? (focused ? 4 : 3) : 1.5,
    opacity: on ? 1 : 0.2,
    fillColor: color,
    fillOpacity: on ? (focused ? 0.28 : 0.16) : 0.02,
    dashArray: flagged && grouped ? '5 4' : undefined, // an outlier within its group
  };
}

function casingFor(main: L.PathOptions): L.PathOptions {
  const on = (main.opacity ?? 1) > 0.5;
  return {
    color: MC.navBg, weight: (main.weight ?? 3) + 3.5, opacity: on ? 0.8 : 0.1, fill: false, interactive: false,
  };
}

const toLatLngs = (geom: DraftMask['geometry']): L.LatLngExpression[][] =>
  (geom as unknown as { coordinates: number[][][] }).coordinates.map((ring) =>
    ring.map(([lng, lat]) => [lat, lng] as L.LatLngExpression),
  );

export function InteractiveMapLayer() {
  const active = useInteractiveStore((s) => s.active);
  const mapReady = useMapStore((s) => s.mapReady);
  const Lref = useRef<typeof L | null>(null);
  const polys = useRef<Map<string, L.Polygon>>(new Map());
  const casings = useRef<Map<string, L.Polygon>>(new Map());
  // The geometry each outline was last drawn from, so an edited mask (re-segmented, refined) is redrawn.
  const drawnGeom = useRef(new Map<string, unknown>());
  const lastView = useRef<'mask' | 'box'>('mask');
  const frameLayers = useRef<L.Layer[]>([]);
  const maskRenderer = useRef<L.Canvas | null>(null);
  const syncMasks = useRef<() => void>(() => {});
  const pickActive = useInteractiveStore((s) => s.pick.active);
  const stage = useInteractiveStore((s) => s.stage);

  // ── Frame + scrim (mode on/off, AOI change) ───────────────────────────────
  useEffect(() => {
    if (!active || !mapReady) return;
    let cancelled = false;
    const cleanup: (() => void)[] = [];

    (async () => {
      const Lf: typeof L = (await import('leaflet')).default;
      const map = getMapManager().getMap();
      if (cancelled || !map) return;
      Lref.current = Lf;
      const { aoiBbox, aoiGeometry } = useInteractiveStore.getState();
      if (!aoiBbox) return;

      const mkPane = (name: string, z: number, pointer: string) => {
        const pane = map.getPane(name) ?? map.createPane(name);
        pane.style.zIndex = String(z);
        pane.style.pointerEvents = pointer;
        return pane;
      };
      mkPane(PANE_SCRIM, 410, 'none');
      mkPane(PANE_MASKS, 430, 'none');
      mkPane(PANE_FRAME, 440, 'none');
      maskRenderer.current = Lf.canvas({ pane: PANE_MASKS, padding: 0.3 });

      const [w, s, e, n] = aoiBbox;
      const aoiRing: L.LatLngExpression[] =
        aoiGeometry && (aoiGeometry as { type?: string }).type === 'Polygon'
          ? toLatLngs(aoiGeometry as unknown as DraftMask['geometry'])[0]
          : [[s, w], [s, e], [n, e], [n, w]];
      const world: L.LatLngExpression[] = [[-90, -180], [-90, 180], [90, 180], [90, -180]];

      const scrim = Lf.polygon([world, aoiRing], {
        pane: PANE_SCRIM, stroke: false, fillColor: SCRIM_FILL, fillOpacity: 1, interactive: false,
      }).addTo(map);
      // Boundary: a dark underlay + heavy gold line reads on any imagery, light or dark.
      const frameUnder = Lf.polygon(aoiRing, {
        pane: PANE_FRAME, color: MC.navBg, weight: 9, opacity: 0.9, fill: false, interactive: false, lineJoin: 'miter',
      }).addTo(map);
      const frame = Lf.polygon(aoiRing, {
        pane: PANE_FRAME, color: MC.accent, weight: 4.5, opacity: 1, fill: false, interactive: false, lineJoin: 'miter',
      }).addTo(map);
      const corners = ([[s, w], [s, e], [n, e], [n, w]] as [number, number][]).map(([lat, lng]) =>
        Lf.marker([lat, lng], {
          pane: PANE_FRAME, interactive: false, keyboard: false,
          icon: Lf.divIcon({
            className: '',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
            html: `<div style="width:16px;height:16px;background:${MC.accent};border:3px solid ${MC.navBg};box-sizing:border-box"></div>`,
          }),
        }).addTo(map),
      );
      const ha = bboxHectares([w, s, e, n]);
      const label = Lf.marker([n, w], {
        pane: PANE_FRAME, interactive: false, keyboard: false,
        icon: Lf.divIcon({
          className: '',
          iconSize: [0, 0],
          iconAnchor: [-2, 34],
          html: `<div style="position:absolute;white-space:nowrap;background:${MC.navBg};color:${MC.accent};border:2px solid ${MC.accent};padding:3px 9px;font:700 11px/1.2 system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;box-shadow:0 2px 8px rgba(0,0,0,.4)">${esc(useInteractiveStore.getState().aoiName)} · ${ha.toFixed(ha < 10 ? 2 : 1)} ha</div>`,
        }),
      }).addTo(map);
      frameLayers.current = [scrim, frameUnder, frame, label, ...corners];

      map.fitBounds(Lf.latLngBounds([[s, w], [n, e]]), {
        paddingTopLeft: [24, 24], paddingBottomRight: [412, 24], maxZoom: 23, animate: true,
      });

      syncMasks.current(); // masks may have streamed in before Leaflet was ready

      cleanup.push(() => {
        frameLayers.current.forEach((l) => l.remove());
        frameLayers.current = [];
        polys.current.forEach((p) => p.remove());
        polys.current.clear();
        casings.current.forEach((p) => p.remove());
        casings.current.clear();
        maskRenderer.current = null;
      });
    })();

    return () => {
      cancelled = true;
      cleanup.forEach((fn) => fn());
    };
  }, [active, mapReady]);

  // ── Masks (diffed by id) ──────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const apply = () => {
      const Lf = Lref.current;
      const map = getMapManager().getMap();
      const renderer = maskRenderer.current;
      if (!Lf || !map || !renderer) return;
      const { masks, strictness, scaleHidden, mapFilter, group, similar, selection, geomView } = useInteractiveStore.getState();
      // Switching between outlines and boxes changes every shape, so start the layer set afresh.
      if (lastView.current !== geomView) {
        polys.current.forEach((p) => p.remove());
        casings.current.forEach((p) => p.remove());
        polys.current.clear();
        casings.current.clear();
        drawnGeom.current.clear();
        lastView.current = geomView;
      }
      const shapeOf = (m: DraftMask): DraftMask['geometry'] => (geomView === 'box' ? (boxGeometry(m.geometry) as unknown as DraftMask['geometry']) : m.geometry);
      const shown = visibleMasks(masks, strictness, scaleHidden);
      const ctx: StyleCtx = {
        colors: new Map(group.clusters.map((c) => [String(c.index), c.color])),
        selected: isFiltering(selection, similar) ? new Set(selectMasks(shown, selection, similar).map((x) => x.id)) : null,
        picked: new Set(selection.picked),
      };
      const keep = new Set(shown.map((m) => m.id));
      polys.current.forEach((p, id) => {
        if (!keep.has(id)) {
          p.remove(); polys.current.delete(id);
          casings.current.get(id)?.remove(); casings.current.delete(id);
          drawnGeom.current.delete(id);
        }
      });
      // A dark casing under every outline keeps it readable; past a few thousand
      // masks the extra paths cost more than they help, so drop it there.
      const useCasing = shown.length <= 2500;
      for (const m of shown) {
        const main = styleFor(m, mapFilter, ctx);
        const existing = polys.current.get(m.id);
        if (existing) {
          if (drawnGeom.current.get(m.id) !== m.geometry) {
            const ll = toLatLngs(shapeOf(m));
            existing.setLatLngs(ll);
            casings.current.get(m.id)?.setLatLngs(ll);
            drawnGeom.current.set(m.id, m.geometry);
          }
          existing.setStyle(main);
          casings.current.get(m.id)?.setStyle(casingFor(main));
        } else {
          if (useCasing) {
            casings.current.set(
              m.id,
              Lf.polygon(toLatLngs(shapeOf(m)), { ...casingFor(main), pane: PANE_MASKS, renderer }).addTo(map),
            );
          }
          const p = Lf.polygon(toLatLngs(shapeOf(m)), {
            ...main, pane: PANE_MASKS, renderer, interactive: false,
          }).addTo(map);
          polys.current.set(m.id, p);
          drawnGeom.current.set(m.id, m.geometry);
        }
      }
    };
    syncMasks.current = apply;
    apply();
    const unsub = useInteractiveStore.subscribe(apply);
    return () => {
      unsub();
      syncMasks.current = () => {};
    };
  }, [active, mapReady]);

  // ── Picker: click = the current mode (+ / −); Shift-click and right-click always exclude ──
  // Listens in the CAPTURE phase on the map container. Existing layers (the AOI shape,
  // annotation polygons) handle their own clicks and stop them propagating, so a bubbling
  // map 'click' never fired when the user clicked over one — which is why picking "worked
  // once" and then seemed dead. Box-zoom (Shift-drag) and double-click zoom are paused so
  // quick +/− clicks can't zoom the map out from under the user.
  useEffect(() => {
    if (!active || !mapReady || !pickActive) return;
    const map = getMapManager().getMap();
    if (!map) return;
    const container = map.getContainer();
    const prevCursor = container.style.cursor;
    const boxZoomWas = map.boxZoom.enabled();
    const dblZoomWas = map.doubleClickZoom.enabled();
    map.boxZoom.disable();
    map.doubleClickZoom.disable();

    let shift = false;
    const paintCursor = () => {
      const exclude = shift || useInteractiveStore.getState().pick.mode === 0;
      container.style.cursor = exclude ? CURSOR_EXCLUDE : CURSOR_INCLUDE;
    };
    paintCursor();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Shift') { shift = e.type === 'keydown'; paintCursor(); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    const unsub = useInteractiveStore.subscribe((st, prev) => { if (st.pick.mode !== prev.pick.mode) paintCursor(); });

    const viewSpan = () => {
      const b = map.getBounds();
      const c = b.getCenter();
      return Math.min(
        map.distance([c.lat, b.getWest()], [c.lat, b.getEast()]),
        map.distance([b.getSouth(), c.lng], [b.getNorth(), c.lng]),
      );
    };
    const isControl = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.('.leaflet-control, .leaflet-pm-toolbar, .leaflet-pm-actions-container');
    let down: { x: number; y: number } | null = null;
    const onDown = (e: MouseEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const send = (e: MouseEvent, label: 0 | 1) => {
      const ll = map.mouseEventToLatLng(e);
      void useInteractiveStore.getState().pickClick({ lat: ll.lat, lng: ll.lng, label, viewSpanM: viewSpan() });
    };
    const onClick = (e: MouseEvent) => {
      if (isControl(e)) return;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // a pan, not a click
      e.stopPropagation(); // keep the layer under the cursor from also reacting
      e.preventDefault();
      send(e, e.shiftKey ? 0 : useInteractiveStore.getState().pick.mode);
    };
    const onContext = (e: MouseEvent) => {
      if (isControl(e)) return;
      e.stopPropagation();
      e.preventDefault();
      send(e, 0);
    };
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('click', onClick, true);
    container.addEventListener('contextmenu', onContext, true);
    return () => {
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('click', onClick, true);
      container.removeEventListener('contextmenu', onContext, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      unsub();
      if (boxZoomWas) map.boxZoom.enable();
      if (dblZoomWas) map.doubleClickZoom.enable();
      container.style.cursor = prevCursor;
    };
  }, [active, mapReady, pickActive]);

  // ── Click a mask to select it (Group and Clean stages) ────────────────────
  // Capture phase, like the picker, so layers underneath can't swallow the click. A click on a
  // mask selects just that mask (Shift adds or removes it); a click on bare imagery clears the picks.
  useEffect(() => {
    if (!active || !mapReady || pickActive || (stage !== 'group' && stage !== 'clean')) return;
    const map = getMapManager().getMap();
    if (!map) return;
    const container = map.getContainer();
    let down: { x: number; y: number } | null = null;
    const isControl = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.('.leaflet-control');
    const onDown = (e: MouseEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onClick = (e: MouseEvent) => {
      if (isControl(e)) return;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // a pan, not a click
      const st = useInteractiveStore.getState();
      const ll = map.mouseEventToLatLng(e);
      const shown = visibleMasks(st.masks, st.strictness, st.scaleHidden);
      // In the box view a click anywhere inside a box selects that mask.
      const hit = hitTest(st.geomView === 'box' ? (shown.map((m) => ({ ...m, geometry: boxGeometry(m.geometry) })) as unknown as DraftMask[]) : shown, ll.lat, ll.lng);
      if (hit) {
        e.stopPropagation();
        e.preventDefault();
        st.pickMask(hit.id, e.shiftKey || e.ctrlKey || e.metaKey);
      } else if (!e.shiftKey && st.selection.picked.length > 0) {
        useInteractiveStore.setState((s) => ({ selection: { ...s.selection, picked: [] } }));
      }
    };
    container.addEventListener('mousedown', onDown, true);
    container.addEventListener('click', onClick, true);
    return () => {
      container.removeEventListener('mousedown', onDown, true);
      container.removeEventListener('click', onClick, true);
    };
  }, [active, mapReady, pickActive, stage]);

  // The object being outlined: provisional dashed outline, the clicks (green +, red −)
  // and the imagery window SAM is reading. All redrawn whenever the pick state changes.
  useEffect(() => {
    if (!active) return;
    const layers: L.Layer[] = [];
    const clear = () => { layers.splice(0).forEach((l) => l.remove()); };
    const draw = () => {
      clear();
      const Lf = Lref.current;
      const map = getMapManager().getMap();
      const renderer = maskRenderer.current;
      if (!Lf || !map || !renderer) return;
      const { pending, points, window } = useInteractiveStore.getState().pick;
      const add = <T extends L.Layer>(l: T): T => { l.addTo(map); layers.push(l); return l; };

      if (window) {
        add(Lf.rectangle([[window[1], window[0]], [window[3], window[2]]], {
          pane: PANE_MASKS, renderer, interactive: false, color: '#ffffff', weight: 1.5, dashArray: '2 6', fill: false, opacity: 0.8,
        }));
      }
      if (pending) {
        const ll = toLatLngs(pending.geometry);
        add(Lf.polygon(ll, { pane: PANE_MASKS, renderer, interactive: false, color: MC.navBg, weight: 8.5, opacity: 0.85, fill: false }));
        add(Lf.polygon(ll, {
          pane: PANE_MASKS, renderer, interactive: false, color: '#ffffff', weight: 5, dashArray: '8 6',
          fillColor: COLOR_UNLABELLED, fillOpacity: 0.35,
        }));
      }
      for (const p of points) {
        const color = p.label === 1 ? '#3fbf5a' : '#e5484d';
        add(Lf.circleMarker([p.lat, p.lng], { pane: PANE_MASKS, renderer, interactive: false, radius: 9, color: MC.navBg, weight: 5, fill: false }));
        add(Lf.circleMarker([p.lat, p.lng], { pane: PANE_MASKS, renderer, interactive: false, radius: 9, color: '#ffffff', weight: 3, fillColor: color, fillOpacity: 1 }));
      }
    };
    draw();
    const unsub = useInteractiveStore.subscribe((s, prev) => {
      if (s.pick.pending !== prev.pick.pending || s.pick.points !== prev.pick.points || s.pick.window !== prev.pick.window) draw();
    });
    return () => { unsub(); clear(); };
  }, [active, mapReady]);

  return null;
}
