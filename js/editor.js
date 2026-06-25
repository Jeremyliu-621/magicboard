// In-app editor: reshape character poses per action, tune stats/hitboxes, drag
// platforms/spawns, edit global settings. Mutates the same Store the game reads.
(function (global) {
  'use strict';
  const DS = global.DS;
  const D = DS.draw;

  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  class Editor {
    constructor(game, canvas, panel) {
      this.game = game; this.canvas = canvas; this.panel = panel;
      this.active = false;
      this.subtab = 'draw';
      this.charName = game.data.roster[0];
      this.action = 'idle';
      this.editMap = game.mapId || 'meadow'; // which stage the Stage tab edits (any map, not just Meadow)
      this._sv = null;                        // stage-tab view transform (fits the whole selected map)
      this.selPlat = null; this.selPortal = null; this.drag = null;
      this.platDraw = false; this.platStroke = null; // freehand "draw a platform" mode
      this._saveTimer = 0;
      // draw-tool state
      this.brush = 5; this.drawMode = 'auto'; this.draw = null; this.strokeHistory = [];
      this.erase = false; this.erasing = false; // eraser: drag to delete strokes on contact
      this.Z = 8; // mannequin zoom (mannequin units -> view px)
      // optional reference image (loaded from disk) imprinted behind the Draw canvas to trace over.
      // drag it on the canvas to position, scroll to resize — no sliders.
      this.traceImg = null; this.traceLoaded = false; this.traceAlpha = 0.4;
      this.traceScale = 0.12; this.traceX = 0; this.traceY = -10;
      this.refMove = false; this.refDrag = null;
      this._bindCanvas();
    }
    get data() { return DS.Store.data; }

    // ---------- stage-editing helpers (work on ANY map's persistent stage) ----------
    _stage() { return DS.Maps.stageFor(this.data, this.editMap); }     // the stage object being edited
    // the world rectangle to frame: the map's play-bounds, expanded to include every platform/spawn
    _ext(st) {
      let x0, y0, x1, y1;
      if (st.bounds) { x0 = st.bounds.x0; y0 = st.bounds.y0; x1 = st.bounds.x1; y1 = st.bounds.y1; }
      else { x0 = 0; y0 = 0; x1 = this.data.view.w; y1 = this.data.view.h; }
      for (const p of st.platforms) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h); }
      for (const s of st.spawns || []) { x0 = Math.min(x0, s.x - 40); y0 = Math.min(y0, s.y - 70); x1 = Math.max(x1, s.x + 40); y1 = Math.max(y1, s.y + 40); }
      for (const pt of st.portals || []) { x0 = Math.min(x0, pt.x - pt.r); y0 = Math.min(y0, pt.y - pt.r); x1 = Math.max(x1, pt.x + pt.r); y1 = Math.max(y1, pt.y + pt.r); }
      return { x0, y0, x1, y1 };
    }
    // fit a world rectangle into the canvas (with padding) -> {scale, ox, oy}
    _stageView(cssW, cssH, ext) {
      const pad = 46, ew = Math.max(1, ext.x1 - ext.x0), eh = Math.max(1, ext.y1 - ext.y0);
      const scale = Math.min((cssW - pad * 2) / ew, (cssH - pad * 2) / eh);
      return { scale, ox: (cssW - ew * scale) / 2 - ext.x0 * scale, oy: (cssH - eh * scale) / 2 - ext.y0 * scale, ext };
    }
    _toStage(e) { // client -> stage world coords (uses the live stage-tab transform)
      const r = this.canvas.getBoundingClientRect(), sv = this._sv || { scale: 1, ox: 0, oy: 0 };
      return { x: (e.clientX - r.left - sv.ox) / sv.scale, y: (e.clientY - r.top - sv.oy) / sv.scale };
    }

    activate() { this.active = true; this.panel.hidden = false; this.charName = this.data.roster[0]; this.build(); }
    deactivate() { this.active = false; this.panel.hidden = true; }
    editWorldStage(world) {
      this.subtab = 'stage';
      this.editMap = (world && (world.mapId || world.id)) || this.game.mapId || 'meadow';
      this.selPlat = null; this.selPortal = null; this.drag = null; this.platStroke = null; this.platDraw = false;
      this.activate();
    }

    queueSave() { clearTimeout(this._saveTimer); this._saveTimer = setTimeout(() => DS.Store.save(), 250); }

    // ---------- panel UI ----------
    build() {
      const p = this.panel; p.innerHTML = '';
      const tabs = el('div', 'ed-tabs');
      [['draw', 'Draw'], ['stage', 'Stage'], ['settings', 'Settings']].forEach(([t, label]) => {
        const b = el('button', this.subtab === t ? 'on' : '', label);
        b.onclick = () => { this.subtab = t; this.build(); };
        tabs.appendChild(b);
      });
      p.appendChild(tabs);

      if (this.subtab === 'draw') this._buildDraw(p);
      else if (this.subtab === 'stage') this._buildStage(p);
      else this._buildSettings(p);

      // common buttons
      const btns = el('div', 'ed-btns');
      const mk = (label, fn) => { const b = el('button', '', label); b.onclick = fn; return b; };
      btns.appendChild(mk('Save', () => { DS.Store.save(); this._toast('Saved ✓'); }));
      btns.appendChild(mk('Reset all', () => this._modal({
        title: 'Reset everything?',
        body: 'This clears all fighters, stages and settings back to their defaults.',
        confirmLabel: 'Reset all',
        onConfirm: () => { DS.Store.reset(); this.game.rebuild(); this.build(); this._toast('Reset to defaults'); },
      })));
      btns.appendChild(mk('Export', () => this._export()));
      btns.appendChild(mk('Import', () => this._import()));
      btns.appendChild(mk('▶ Play test', () => { if (this.subtab === 'stage') this.game.mapId = this.editMap; document.querySelector('.tab[data-tab="play"]').click(); this.game.rebuild(); this.game.start(); }));
      p.appendChild(btns);
    }

    // a themed in-app dialog (replaces native confirm) — a paper card over a dimmed backdrop
    _modal(opts) {
      const wrap = el('div', 'ed-modal');
      const card = el('div', 'ed-modal-card');
      const close = () => { wrap.remove(); window.removeEventListener('keydown', onKey, true); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); if (DS.Audio) DS.Audio.play('ui_back'); } };
      card.appendChild(el('div', 'ed-modal-title', opts.title || 'Are you sure?'));
      if (opts.body) card.appendChild(el('div', 'ed-modal-body', opts.body));
      const row = el('div', 'ed-modal-btns');
      const cancel = el('button', 'ed-modal-cancel', opts.cancelLabel || 'Cancel');
      cancel.onclick = () => { close(); if (DS.Audio) DS.Audio.play('ui_back'); };
      const ok = el('button', 'ed-modal-confirm', opts.confirmLabel || 'Confirm');
      ok.onclick = () => { close(); if (DS.Audio) DS.Audio.play('ui_confirm'); if (opts.onConfirm) opts.onConfirm(); };
      row.appendChild(cancel); row.appendChild(ok); card.appendChild(row);
      wrap.appendChild(card);
      wrap.onclick = (e) => { if (e.target === wrap) { close(); if (DS.Audio) DS.Audio.play('ui_back'); } };
      document.body.appendChild(wrap);
      window.addEventListener('keydown', onKey, true);
      ok.focus();
    }

    // a brief themed toast for lightweight feedback (Save, import result)
    _toast(msg) {
      const t = el('div', 'ed-toast', msg);
      document.body.appendChild(t);
      requestAnimationFrame(() => t.classList.add('show'));
      setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 1500);
    }

    // a small DPR-correct canvas with a hand-drawn icon painted into it
    _iconCanvas(w, h, drawFn) {
      const c = el('canvas');
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = w * dpr; c.height = h * dpr; c.style.width = w + 'px'; c.style.height = h + 'px';
      const ctx = c.getContext('2d'); ctx.scale(dpr, dpr); drawFn(ctx);
      return c;
    }

    // hand-drawn, coloured doodle icons for the Stage-tab buttons (28x22 canvas)
    _stageIcon(ctx, kind) {
      const D = DS.draw, ink = D.COL.ink, paper = D.COL.paper;
      const r = (s) => DS.makeRng(s);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (kind === 'platform') {
        const wood = '#9c6b3f';
        D.strokePts(ctx, [[3, 9], [25, 9], [25, 15], [3, 15]], { width: 2.4, color: ink, rnd: r(2), closed: true, fill: D.mix(paper, wood, 0.5) });
        D.line(ctx, 10, 9.5, 10, 14.5, { width: 1.4, color: ink, rnd: r(3), passes: 1 });
        D.line(ctx, 18, 9.5, 18, 14.5, { width: 1.4, color: ink, rnd: r(4), passes: 1 });
      } else if (kind === 'cannon') {
        const metal = '#5f5a54';
        D.circle(ctx, 9, 16, 4, { width: 2.2, color: ink, rnd: r(5), fill: D.mix(paper, metal, 0.35) });
        ctx.save(); ctx.translate(13, 12); ctx.rotate(-0.5);
        D.strokePts(ctx, [[-4, -4], [10, -4], [10, 4], [-4, 4]], { width: 2.2, color: ink, rnd: r(6), closed: true, fill: D.mix(paper, metal, 0.5) });
        D.circle(ctx, 10, 0, 2.6, { width: 1.8, color: ink, rnd: r(7), fill: ink });
        ctx.restore();
      } else if (kind === 'bouncy') {
        const c = '#d4663f';
        D.strokePts(ctx, [[5, 11], [23, 11], [21, 16], [7, 16]], { width: 2.2, color: ink, rnd: r(8), closed: true, fill: D.mix(paper, c, 0.42) });
        D.line(ctx, 8, 16, 7, 20, { width: 2, color: ink, rnd: r(9), passes: 1 });
        D.line(ctx, 20, 16, 21, 20, { width: 2, color: ink, rnd: r(10), passes: 1 });
        D.line(ctx, 14, 9, 14, 3, { width: 2, color: c, rnd: r(11), passes: 1 });
        D.line(ctx, 11, 6, 14, 3, { width: 2, color: c, rnd: r(12), passes: 1 });
        D.line(ctx, 17, 6, 14, 3, { width: 2, color: c, rnd: r(13), passes: 1 });
      } else if (kind === 'spikes') {
        const c = '#b3402a';
        D.line(ctx, 3, 17, 25, 17, { width: 2, color: ink, rnd: r(14), passes: 1 });
        [8, 14, 20].forEach((x, i) => D.strokePts(ctx, [[x - 3.4, 17], [x, 5], [x + 3.4, 17]], { width: 1.9, color: ink, rnd: r(15 + i), closed: true, fill: D.mix(paper, c, 0.5) }));
      } else if (kind === 'portal') {
        const c = '#9a6cb0';
        ctx.save(); ctx.translate(14, 11.5); ctx.scale(0.66, 1.05);
        D.circle(ctx, 0, 0, 9, { width: 2.8, color: c, rnd: r(20) });
        D.circle(ctx, 0, 0, 5, { width: 1.8, color: D.mix(c, ink, 0.35), rnd: r(21) });
        ctx.restore();
      } else if (kind === 'delete') {
        const c = '#c0603a';
        D.circle(ctx, 14, 11.5, 8, { width: 2.4, color: c, rnd: r(30) });
        D.line(ctx, 9.5, 11.5, 18.5, 11.5, { width: 2.4, color: c, rnd: r(31), passes: 1 });
      } else if (kind === 'draw') {
        const c = '#3f6fa0';
        ctx.save(); ctx.translate(13, 12); ctx.rotate(0.7);
        D.strokePts(ctx, [[-9, -2.5], [6, -2.5], [6, 2.5], [-9, 2.5]], { width: 2, color: ink, rnd: r(40), closed: true, fill: D.mix(paper, c, 0.42) });
        D.strokePts(ctx, [[6, -2.5], [11, 0], [6, 2.5]], { width: 2, color: ink, rnd: r(41), closed: true, fill: D.COL.paperShade });
        D.line(ctx, -9, -2.5, -9, 2.5, { width: 2, color: ink, rnd: r(42), passes: 1 });
        ctx.restore();
      } else if (kind === 'reset') {
        const c = '#3f8f86';
        ctx.strokeStyle = c; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.arc(14, 12, 7, Math.PI * 0.45, Math.PI * 1.95); ctx.stroke();
        const a = Math.PI * 0.45, ex = 14 + Math.cos(a) * 7, ey = 12 + Math.sin(a) * 7;
        D.strokePts(ctx, [[ex - 4, ey - 1], [ex + 1, ey + 1], [ex - 1, ey + 5]], { width: 1.8, color: c, rnd: r(50), closed: true, fill: c });
      }
    }

    // a fitted mini-render of a map's stage for the Stage-tab map grid (reflects live edits)
    _mapTilePreview(ctx, id, w, h) {
      ctx.fillStyle = DS.draw.COL.paper; ctx.fillRect(0, 0, w, h);
      let stage; try { stage = DS.Maps.stageFor(this.data, id); } catch (e) { stage = null; }
      if (!stage || !stage.platforms || !stage.platforms.length) return;
      const ps = stage.platforms; let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
      for (const pl of ps) { a = Math.min(a, pl.x); b = Math.min(b, pl.y); c = Math.max(c, pl.x + pl.w); d = Math.max(d, pl.y + pl.h); }
      const spanX = c - a, spanY = d - b;
      const padX = spanX * 0.05 + 70, padTop = spanY * 0.4 + 130, padBot = spanY * 0.26 + 90;
      const wx0 = a - padX, wx1 = c + padX, wy0 = b - padTop, wy1 = d + padBot;
      const sc = Math.min(w / (wx1 - wx0), h / (wy1 - wy0));
      const ww = (wx1 - wx0) * sc, hh = (wy1 - wy0) * sc;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
      ctx.translate((w - ww) / 2 - wx0 * sc, (h - hh) / 2 - wy0 * sc);
      ctx.scale(sc, sc);
      try { DS.stage.drawBackground(ctx, stage, null, null); DS.stage.drawStage(ctx, stage, null, null); } catch (e) { /* preview-only */ }
      ctx.restore();
    }

    _slider(parent, label, min, max, step, get, set) {
      const row = el('div', 'ed-row');
      row.appendChild(el('label', '', label));
      const i = el('input'); i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = get();
      const v = el('span', 'val', (+get()).toFixed(step < 1 ? 2 : 0));
      i.oninput = () => { set(+i.value); v.textContent = (+i.value).toFixed(step < 1 ? 2 : 0); this.queueSave(); };
      row.appendChild(i); row.appendChild(v); parent.appendChild(row); return i;
    }
    _num(parent, label, step, get, set) {
      const row = el('div', 'ed-row'); row.appendChild(el('label', '', label));
      const i = el('input'); i.type = 'number'; i.step = step; i.value = get();
      i.oninput = () => { set(+i.value); this.queueSave(); };
      row.appendChild(i); parent.appendChild(row); return i;
    }

    _ensureSkin(ch) { if (!ch.skin) ch.skin = DS.skin.emptySkin(); return ch.skin; }

    _buildDraw(p) {
      const ch = this.data.characters[this.charName];
      this._ensureSkin(ch);

      const row = el('div', 'ed-row'); row.appendChild(el('label', '', 'Character'));
      const sel = el('select');
      this.data.roster.forEach((n) => { const o = el('option', '', n); o.value = n; if (n === this.charName) o.selected = true; sel.appendChild(o); });
      sel.onchange = () => { this.charName = sel.value; this.build(); };
      row.appendChild(sel); p.appendChild(row);

      p.appendChild(el('div', 'ed-note', 'Draw your fighter right on top of the ghost body. Each stroke is auto-sorted into the body part it lands on. Draw all 6 parts: head, body, both arms, both legs.'));

      p.appendChild(el('h3', '', 'Draw into'));
      const modes = [['auto', 'Auto'], ['head', 'Head'], ['body', 'Body'], ['armFront', 'Arm front'], ['armBack', 'Arm back'], ['legFront', 'Leg front'], ['legBack', 'Leg back']];
      const seg = el('div', 'ed-seg');
      modes.forEach(([m, label]) => { const b = el('button', this.drawMode === m ? 'on' : '', label); b.onclick = () => { this.drawMode = m; this.build(); }; seg.appendChild(b); });
      p.appendChild(seg);
      p.appendChild(el('div', 'ed-note', this.drawMode === 'auto' ? 'Auto: strokes snap to the nearest body part.' : 'Locked to "' + this.drawMode + '" — every stroke goes here.'));

      this._slider(p, 'brush size', 2, 14, 1, () => this.brush, (v) => this.brush = v);

      const erRow = el('div', 'ed-btns');
      const erBtn = el('button', this.erase ? 'on' : '', this.erase ? '🧽 Eraser — ON (drag to erase)' : '🧽 Eraser');
      erBtn.onclick = () => { this.erase = !this.erase; this.build(); };
      erRow.appendChild(erBtn); p.appendChild(erRow);

      const tog = el('div', 'ed-row'); tog.appendChild(el('label', '', 'use drawing'));
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = ch.skin.enabled;
      cb.onchange = () => { ch.skin.enabled = cb.checked; this.queueSave(); }; tog.appendChild(cb); p.appendChild(tog);
      p.appendChild(el('div', 'ed-note', 'Off = use the built-in default (bear) instead of your drawing.'));

      // optional reference image to trace over — drag on the canvas to move, scroll to resize
      p.appendChild(el('h3', '', 'Reference (optional)'));
      const refRow = el('div', 'ed-btns');
      const fi = el('input'); fi.type = 'file'; fi.accept = 'image/*'; fi.style.display = 'none';
      fi.onchange = () => {
        const f = fi.files && fi.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = () => { const img = new Image(); img.onload = () => { this.traceLoaded = true; this.refMove = true; this.build(); }; img.src = r.result; this.traceImg = img; };
        r.readAsDataURL(f);
      };
      const loadBtn = el('button', '', this._refReady() ? '📷 Replace…' : '📷 Load reference…');
      loadBtn.onclick = () => fi.click();
      refRow.appendChild(loadBtn); refRow.appendChild(fi);
      if (this._refReady()) {
        const moveBtn = el('button', this.refMove ? 'on' : '', this.refMove ? '✥ Moving — drag / scroll on canvas' : '✥ Move / resize');
        moveBtn.onclick = () => { this.refMove = !this.refMove; this.build(); };
        const rmBtn = el('button', '', '✕ Remove');
        rmBtn.onclick = () => { this.traceImg = null; this.traceLoaded = false; this.refMove = false; this.build(); };
        refRow.appendChild(moveBtn); refRow.appendChild(rmBtn);
      }
      p.appendChild(refRow);
      if (this._refReady()) {
        this._slider(p, 'reference opacity', 0.05, 0.85, 0.05, () => this.traceAlpha, (v) => this.traceAlpha = v);
        p.appendChild(el('div', 'ed-note', this.refMove ? 'Drag the picture on the canvas to position it, scroll to resize. Then turn Move off and trace over it.' : 'Lock a body part above, then trace over the picture.'));
      }

      const btns = el('div', 'ed-btns');
      const mk = (t, fn) => { const b = el('button', '', t); b.onclick = fn; return b; };
      btns.appendChild(mk('Undo stroke', () => {
        const part = this.strokeHistory.pop();
        if (part && ch.skin.parts[part].strokes.length) { ch.skin.parts[part].strokes.pop(); this.queueSave(); }
      }));
      btns.appendChild(mk(this.drawMode !== 'auto' ? 'Clear ' + this.drawMode : 'Clear part', () => {
        if (this.drawMode !== 'auto') { ch.skin.parts[this.drawMode].strokes = []; this.queueSave(); }
      }));
      btns.appendChild(mk('Clear all', () => this._modal({ title: 'Clear the whole drawing?', confirmLabel: 'Clear', onConfirm: () => { ch.skin = DS.skin.emptySkin(); this.strokeHistory = []; this.queueSave(); this.build(); } })));
      p.appendChild(btns);

      // stroke counts
      const counts = DS.skin.PARTS.map((k) => k + ': ' + ch.skin.parts[k].strokes.length).join('  ·  ');
      p.appendChild(el('div', 'ed-note', counts));
    }


    _buildStage(p) {
      // map picker — a grid of preview tiles (EVERY stage is editable, not just Meadow)
      const maps = DS.Maps.list().slice();
      if (!maps.some((m) => m.id === this.editMap)) {
        const custom = DS.Maps.get(this.editMap);
        maps.unshift({ id: this.editMap, name: (this._stage() && this._stage().name) || custom.name || 'Custom Level' });
      }
      p.appendChild(el('h3', '', 'Map'));
      const grid = el('div', 'ed-mapgrid');
      maps.forEach((m) => {
        const tile = el('button', 'ed-maptile' + (m.id === this.editMap ? ' sel' : ''));
        tile.appendChild(this._iconCanvas(94, 58, (ctx) => this._mapTilePreview(ctx, m.id, 94, 58)));
        tile.appendChild(el('span', 'ed-maptile-name', m.name));
        tile.onclick = () => { this.editMap = m.id; this.selPlat = null; this.selPortal = null; this.build(); };
        grid.appendChild(tile);
      });
      p.appendChild(grid);

      const st = this._stage();
      p.appendChild(el('div', 'ed-note', 'Add / drag / resize platforms AND gimmicks (cannons, trampolines, portals). Drag a platform’s bottom-right corner (or a portal’s nub) to resize. Drag spawns (dotted circles). Edits are saved and used in matches.'));

      // freehand draw-a-platform toggle (drag a squiggle on the stage → it becomes a platform)
      const drawRow = el('div', 'ed-btns');
      const drawBtn = el('button', 'ed-iconbtn' + (this.platDraw ? ' on' : ''));
      drawBtn.appendChild(this._iconCanvas(28, 22, (ctx) => this._stageIcon(ctx, 'draw')));
      drawBtn.appendChild(el('span', '', this.platDraw ? 'Drawing… (tap to stop)' : 'Draw a platform'));
      drawBtn.onclick = () => { this.platDraw = !this.platDraw; this.platStroke = null; if (this.platDraw) { this.selPlat = null; this.selPortal = null; } this.build(); };
      drawRow.appendChild(drawBtn); p.appendChild(drawRow);
      if (this.platDraw) p.appendChild(el('div', 'ed-note', 'Drag right on the stage to trace a platform — your squiggle becomes a ledge you can stand on. Tap the button again to stop.'));

      const addr = el('div', 'ed-btns ed-stagegrid');
      const mkb = (kind, label, fn) => {
        const b = el('button', 'ed-iconbtn'); b.onclick = fn;
        b.appendChild(this._iconCanvas(28, 22, (ctx) => this._stageIcon(ctx, kind)));
        b.appendChild(el('span', '', label)); addr.appendChild(b);
      };
      mkb('platform', 'Platform', () => this._addPlat(st, {}));
      mkb('cannon', 'Cannon', () => this._addPlat(st, { w: 86, h: 52, kind: 'cannon', pass: false, fire: { deg: 0, every: 2.0, speed: 880, damage: 11, kbBase: 32, kbScale: 0.12, r: 26, delay: 0 } }));
      mkb('bouncy', 'Bouncy', () => this._addPlat(st, { w: 360, h: 60, kind: 'trampoline', pass: false, bounce: 1300 }));
      mkb('spikes', 'Spikes', () => this._addPlat(st, { w: 260, h: 44, kind: 'spikes', pass: false, hurt: { damage: 26, kbBase: 40, kbScale: 0.18, cooldown: 0.6 } }));
      mkb('portal', 'Portal', () => this._addPortalPair(st));
      mkb('delete', 'Delete selected', () => {
        if (this.selPortal) { const pt = this.selPortal; st.portals = (st.portals || []).filter((q) => q !== pt && q.id !== pt.link && q.link !== pt.id); this.selPortal = null; }
        else if (this.selPlat) { const i = st.platforms.indexOf(this.selPlat); if (i >= 0) st.platforms.splice(i, 1); this.selPlat = null; }
        this.queueSave(); this.build();
      });
      mkb('reset', 'Reset this stage', () => this._modal({
        title: 'Reset ' + DS.Maps.get(this.editMap).name + '?',
        body: 'Restore this stage to its default layout.',
        confirmLabel: 'Reset stage',
        onConfirm: () => { DS.Maps.resetStage(this.data, this.editMap); this.selPlat = null; this.selPortal = null; this.queueSave(); this.build(); },
      }));
      p.appendChild(addr);

      if (this.selPortal && (st.portals || []).indexOf(this.selPortal) >= 0) this._buildPortalProps(p, st, this.selPortal);
      else if (this.selPlat && st.platforms.indexOf(this.selPlat) >= 0) this._buildPlatProps(p, st, this.selPlat);
      else p.appendChild(el('div', 'ed-note', 'Click a platform, cannon, trampoline or portal to select it.'));
    }

    // add a platform (optionally pre-loaded as a cannon/trampoline), centred in the map
    _addPlat(st, props) {
      const ex = this._ext(st), cx = (ex.x0 + ex.x1) / 2, cy = (ex.y0 + ex.y1) / 2;
      const pl = Object.assign({ w: 220, h: 26, kind: 'wood', pass: true }, props);
      pl.x = Math.round(cx - pl.w / 2); pl.y = Math.round(cy - pl.h / 2);
      st.platforms.push(pl); this.selPlat = pl; this.selPortal = null; this.queueSave(); this.build();
    }
    // turn a traced squiggle into a platform: AABB = stroke bbox (the physics box), and the stroke
    // (stored relative to that box) is what gets drawn. Defaults to pass-through so its irregular
    // shape never makes an invisible side-wall — you simply land on top.
    _finishPlatStroke(st) {
      const s = this.platStroke; this.platStroke = null;
      if (!s || s.pts.length < 2) return;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const [x, y] of s.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const padX = 24;
      x0 -= padX; x1 += padX; y0 -= 20; y1 += 50; // pad covers the perpendicular body + rounded end caps
      const w = Math.max(24, x1 - x0), h = Math.max(14, y1 - y0);
      if ((x1 - x0) < 16 && (y1 - y0) < 16) { this.build(); return; } // ignore an accidental dot
      const pl = { x: Math.round(x0), y: Math.round(y0), w: Math.round(w), h: Math.round(h), pass: true, kind: 'drawn',
        pts: s.pts.map(([x, y]) => [Math.round(x - x0), Math.round(y - y0)]) };
      st.platforms.push(pl); this.selPlat = pl; this.selPortal = null; this.queueSave(); this.build();
    }
    _uid(st) { let id; do { id = 'p' + Math.floor(Math.random() * 1e6); } while ((st.portals || []).some((q) => q.id === id)); return id; }
    _addPortalPair(st) {
      const ex = this._ext(st), cx = (ex.x0 + ex.x1) / 2, cy = (ex.y0 + ex.y1) / 2;
      st.portals = st.portals || [];
      const a = { id: this._uid(st), link: '', x: Math.round(cx - 240), y: Math.round(cy), r: 74, col: '#3f6fa0' };
      const b = { id: this._uid(st), link: a.id, x: Math.round(cx + 240), y: Math.round(cy), r: 74, col: '#3f6fa0' };
      a.link = b.id; st.portals.push(a, b);
      this.selPortal = a; this.selPlat = null; this.queueSave(); this.build();
    }

    _buildPlatProps(p, st, pl) {
      // a DRAWN platform keeps its shape (drag to move / corner to resize on the canvas) — here it
      // gets a "type" that restyles it (and Bouncy makes it springy), not the rectangle kinds.
      if (pl.kind === 'drawn') {
        p.appendChild(el('h3', '', 'Drawn platform'));
        const trow = el('div', 'ed-row'); trow.appendChild(el('label', '', 'type'));
        const tsel = el('select');
        [['ledge', 'Ledge'], ['wood', 'Wood'], ['stone', 'Stone'], ['crystal', 'Crystal'], ['bouncy', 'Bouncy']].forEach(([v, label]) => { const o = el('option', '', label); o.value = v; if ((pl.style || 'ledge') === v) o.selected = true; tsel.appendChild(o); });
        tsel.onchange = () => { pl.style = tsel.value; if (pl.style === 'bouncy') { if (pl.bounce == null) pl.bounce = 1300; } else delete pl.bounce; this.queueSave(); this.build(); };
        trow.appendChild(tsel); p.appendChild(trow);
        if (pl.style === 'bouncy') this._slider(p, 'bounce', 400, 2200, 20, () => pl.bounce, (v) => pl.bounce = v);
        p.appendChild(el('div', 'ed-note', 'Keeps its drawn shape; the type changes how it looks. Bouncy springs you up. Drag it on the canvas to move; drag the corner to resize.'));
        return;
      }
      p.appendChild(el('h3', '', 'Selected platform'));
      this._num(p, 'x', 1, () => Math.round(pl.x), (v) => pl.x = v);
      this._num(p, 'y', 1, () => Math.round(pl.y), (v) => pl.y = v);
      this._num(p, 'width', 1, () => Math.round(pl.w), (v) => pl.w = v);
      this._num(p, 'height', 1, () => Math.round(pl.h), (v) => pl.h = v);
      // kind — also turns a platform into a cannon / trampoline (and back)
      const krow = el('div', 'ed-row'); krow.appendChild(el('label', '', 'kind'));
      const ksel = el('select');
      ['ground', 'wood', 'stone', 'crystal', 'box', 'float', 'cannon', 'trampoline', 'spikes'].forEach((k) => { const o = el('option', '', k); o.value = k; if ((pl.kind || 'wood') === k) o.selected = true; ksel.appendChild(o); });
      ksel.onchange = () => {
        const k = ksel.value; pl.kind = k;
        if (k === 'cannon') { if (!pl.fire) pl.fire = { deg: 0, every: 2.0, speed: 880, damage: 11, kbBase: 32, kbScale: 0.12, r: 26, delay: 0 }; pl.pass = false; } else delete pl.fire;
        if (k === 'trampoline') { if (pl.bounce == null) pl.bounce = 1300; pl.pass = false; } else delete pl.bounce;
        if (k === 'spikes') { if (!pl.hurt) pl.hurt = { damage: 26, kbBase: 40, kbScale: 0.18, cooldown: 0.6 }; pl.pass = false; } else delete pl.hurt;
        this.queueSave(); this.build();
      };
      krow.appendChild(ksel); p.appendChild(krow);
      // solid platforms get pass-through + breakable hp; cannons/trampolines are always solid
      if (!pl.fire && pl.bounce == null) {
        const crow = el('div', 'ed-row'); crow.appendChild(el('label', '', 'pass-through'));
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!pl.pass; cb.onchange = () => { pl.pass = cb.checked; this.queueSave(); };
        crow.appendChild(cb); p.appendChild(crow);
        this._num(p, 'breakable hp', 1, () => pl.hp || 0, (v) => { if (v > 0) pl.hp = v; else delete pl.hp; });
      }
      if (pl.fire) {
        p.appendChild(el('h3', '', 'Cannon'));
        this._slider(p, 'angle', -180, 180, 1, () => pl.fire.deg || 0, (v) => pl.fire.deg = v);
        this._slider(p, 'interval (s)', 0.4, 5, 0.1, () => pl.fire.every, (v) => pl.fire.every = v);
        this._slider(p, 'ball speed', 300, 1400, 10, () => pl.fire.speed, (v) => pl.fire.speed = v);
        this._slider(p, 'damage', 1, 30, 1, () => pl.fire.damage, (v) => pl.fire.damage = v);
        this._slider(p, 'ball size', 10, 50, 1, () => pl.fire.r || 26, (v) => pl.fire.r = v);
        p.appendChild(el('div', 'ed-note', 'angle: 0 = right, 90 = up, 180 = left (matches the projectile aim).'));
      }
      if (pl.bounce != null) {
        p.appendChild(el('h3', '', 'Trampoline'));
        this._slider(p, 'bounce', 400, 2200, 20, () => pl.bounce, (v) => pl.bounce = v);
        p.appendChild(el('div', 'ed-note', 'Minimum launch height; a harder landing still flings you higher.'));
      }
      if (pl.hurt) {
        p.appendChild(el('h3', '', 'Spikes (hazard)'));
        this._slider(p, 'damage', 1, 60, 1, () => pl.hurt.damage, (v) => pl.hurt.damage = v);
        this._slider(p, 'knockback', 4, 80, 1, () => pl.hurt.kbBase, (v) => pl.hurt.kbBase = v);
        this._slider(p, 'kb growth', 0, 0.4, 0.01, () => pl.hurt.kbScale, (v) => pl.hurt.kbScale = v);
        this._slider(p, 'hit cooldown (s)', 0.1, 2, 0.05, () => pl.hurt.cooldown, (v) => pl.hurt.cooldown = v);
        p.appendChild(el('div', 'ed-note', 'Touching this platform deals heavy damage + knockback, then flings the fighter off.'));
      }
      if (pl.move) p.appendChild(el('div', 'ed-note', 'This platform MOVES (' + pl.move.type + '); its motion path is preset.'));
    }

    _buildPortalProps(p, st, pt) {
      p.appendChild(el('h3', '', 'Selected portal'));
      this._num(p, 'x', 1, () => Math.round(pt.x), (v) => pt.x = v);
      this._num(p, 'y', 1, () => Math.round(pt.y), (v) => pt.y = v);
      this._slider(p, 'radius', 30, 160, 1, () => pt.r, (v) => pt.r = v);
      const crow = el('div', 'ed-row'); crow.appendChild(el('label', '', 'colour'));
      const seg = el('div', 'ed-seg');
      ['#3f6fa0', '#9a6cb0', '#3f8f86', '#d4663f', '#b58a2e'].forEach((c) => {
        const b = el('button', pt.col === c ? 'on' : ''); b.style.background = c; b.style.minWidth = '24px'; b.style.width = '24px'; b.style.height = '22px';
        b.onclick = () => { pt.col = c; const partner = (st.portals || []).find((q) => q.id === pt.link); if (partner) partner.col = c; this.queueSave(); this.build(); };
        seg.appendChild(b);
      });
      crow.appendChild(seg); p.appendChild(crow);
      p.appendChild(el('div', 'ed-note', 'Portals come in linked PAIRS — step into one, pop out the other. “− selected” removes the whole pair.'));
    }

    _buildSettings(p) {
      const s = this.data.settings;
      p.appendChild(el('h3', '', 'Match'));
      this._slider(p, 'gravity', 1200, 3600, 50, () => s.gravity, (v) => s.gravity = v);
      this._slider(p, 'timer (s)', 0, 300, 5, () => s.timerSeconds, (v) => s.timerSeconds = v);
      this._slider(p, 'stocks', 1, 9, 1, () => s.stocks, (v) => s.stocks = v);
      this._slider(p, 'knockback', 0.4, 2.2, 0.05, () => s.knockbackScale, (v) => s.knockbackScale = v);
      this._slider(p, 'hitstop', 0, 2, 0.1, () => s.hitstop, (v) => s.hitstop = v);
      p.appendChild(el('div', 'ed-note', 'Tip: lower gravity + higher knockback = floatier, more dramatic launches.'));
      p.appendChild(el('h3', '', 'Scenery'));
      this._slider(p, 'dressing', 0, 2, 0.1, () => (s.scenery == null ? 1 : s.scenery), (v) => s.scenery = v);
      p.appendChild(el('div', 'ed-note', 'Auto-grows pillars under platforms + plants on top from the layout (cosmetic). 0 = off. Updates live as you draw/move platforms.'));
    }

    _export() {
      const blob = new Blob([DS.Store.export()], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'doodle-smash.json'; a.click(); URL.revokeObjectURL(a.href);
    }
    _import() {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json';
      inp.onchange = () => { const f = inp.files[0]; if (!f) return; const r = new FileReader();
        r.onload = () => { try { DS.Store.import(r.result); this.game.rebuild(); this.build(); this._toast('Imported ✓'); } catch (e) { this._toast('Import failed: ' + e.message); } };
        r.readAsText(f); };
      inp.click();
    }

    // ---------- canvas interaction ----------
    _toView(e) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: (e.clientX - rect.left - this.game.ox) / this.game.scale,
               y: (e.clientY - rect.top - this.game.oy) / this.game.scale };
    }
    _toMan(e) { // client -> mannequin-local coords
      const v = this._toView(e);
      return { x: (v.x - this.data.view.w / 2) / this.Z, y: (v.y - this.data.view.h / 2) / this.Z };
    }
    // eraser: delete any stroke (across all parts) whose drawn position is within reach of the
    // pointer. `m` is in mannequin coords; strokes display at pivot + stored pts + the offsetY.
    _eraseAt(m) {
      const ch = this.data.characters[this.charName]; if (!ch.skin) return;
      const off = ch.skin.offsetY || 0, R = Math.max(7, this.brush + 3);
      let removed = false;
      for (const name of DS.skin.PARTS) {
        const piv = DS.skin.PIVOTS[name], strokes = ch.skin.parts[name].strokes;
        for (let i = strokes.length - 1; i >= 0; i--) {
          const s = strokes[i], reach = R + (s.w || 5) / 2;
          const hit = (s.pts || []).some(([sx, sy]) => Math.hypot((piv.x + sx) - m.x, (piv.y + sy + off) - m.y) < reach);
          if (hit) { strokes.splice(i, 1); removed = true; }
        }
      }
      if (removed) this.queueSave();
    }
    _finishStroke() {
      const s = this.draw; this.draw = null;
      if (!s || !s.pts.length) return;
      const ch = this.data.characters[this.charName]; this._ensureSkin(ch);
      const part = this.drawMode === 'auto' ? DS.skin.assign(s.pts) : this.drawMode;
      const piv = DS.skin.PIVOTS[part];
      ch.skin.parts[part].strokes.push({ pts: s.pts.map((p) => [p[0] - piv.x, p[1] - piv.y]), w: s.w });
      this.strokeHistory.push(part);
      ch.skin.enabled = true;
      this.queueSave(); this.build();
    }
    _bindCanvas() {
      const cv = this.canvas;
      cv.addEventListener('pointerdown', (e) => {
        if (!this.active) return;
        if (this.subtab === 'draw') {
          const m = this._toMan(e);
          try { cv.setPointerCapture(e.pointerId); } catch (_) {}
          // "Move reference" mode: drag repositions the trace image instead of drawing
          if (this.refMove && this._refReady()) { this.refDrag = { dx: m.x - this.traceX, dy: m.y - this.traceY }; return; }
          if (this.erase) { this.erasing = true; this._eraseAt(m); return; }
          this.draw = { pts: [[m.x, m.y]], w: this.brush };
          return;
        }
        if (this.subtab !== 'stage') return;
        const st = this._stage(), sv = this._sv || { scale: 1 };
        const m = this._toStage(e);
        // freehand draw mode: trace a platform instead of selecting/dragging
        if (this.platDraw) { this.platStroke = { pts: [[m.x, m.y]] }; try { cv.setPointerCapture(e.pointerId); } catch (_) {} return; }
        const hr = 16 / sv.scale; // handle hit-radius in world units (~constant on screen)
        // portals first (drag to move, or grab the radius nub at the bottom to resize)
        for (const pt of st.portals || []) {
          if (Math.hypot(m.x - pt.x, m.y - (pt.y + pt.r)) < 13 / sv.scale) { this.selPortal = pt; this.selPlat = null; this.drag = { mode: 'portalR', t: pt }; this.build(); return; }
          const rx = pt.r * 0.72 || 1, ry = pt.r || 1, ex = (m.x - pt.x) / rx, ey = (m.y - pt.y) / ry;
          if (ex * ex + ey * ey <= 1) { this.selPortal = pt; this.selPlat = null; this.drag = { mode: 'portalMove', t: pt, dx: m.x - pt.x, dy: m.y - pt.y }; this.build(); return; }
        }
        // spawn handles
        for (const sp of st.spawns) {
          if (Math.hypot(sp.x - m.x, sp.y - m.y) < hr) { this.selPortal = null; this.drag = { mode: 'spawn', t: sp }; return; }
        }
        // platforms (topmost last)
        const arr = st.platforms;
        for (let i = arr.length - 1; i >= 0; i--) {
          const pl = arr[i];
          if (m.x >= pl.x && m.x <= pl.x + pl.w && m.y >= pl.y && m.y <= pl.y + pl.h) {
            this.selPlat = pl; this.selPortal = null;
            const corner = Math.hypot(pl.x + pl.w - m.x, pl.y + pl.h - m.y) < 18 / sv.scale;
            this.drag = { mode: corner ? 'resize' : 'move', t: pl, dx: m.x - pl.x, dy: m.y - pl.y,
              ow: pl.w, oh: pl.h, opts: (pl.kind === 'drawn' && pl.pts) ? pl.pts.map((q) => q.slice()) : null };
            this.build(); return;
          }
        }
        this.selPlat = null; this.selPortal = null; this.build();
      });
      window.addEventListener('pointermove', (e) => {
        if (this.refDrag) { const m = this._toMan(e); this.traceX = m.x - this.refDrag.dx; this.traceY = m.y - this.refDrag.dy; return; }
        if (this.erasing) { this._eraseAt(this._toMan(e)); return; }
        if (this.draw) { const m = this._toMan(e); this.draw.pts.push([m.x, m.y]); return; }
        if (this.platStroke) { const m = this._toStage(e); this.platStroke.pts.push([m.x, m.y]); return; }
        if (!this.drag) return;
        const m = this._toStage(e); const d = this.drag;
        if (d.mode === 'spawn') { d.t.x = Math.round(m.x); d.t.y = Math.round(m.y); }
        else if (d.mode === 'move') { d.t.x = Math.round(m.x - d.dx); d.t.y = Math.round(m.y - d.dy); }
        else if (d.mode === 'resize') {
          const nw = Math.max(40, Math.round(m.x - d.t.x)), nh = Math.max(14, Math.round(m.y - d.t.y));
          if (d.opts && d.ow > 0 && d.oh > 0) d.t.pts = d.opts.map(([x, y]) => [Math.round(x * nw / d.ow), Math.round(y * nh / d.oh)]); // a drawn squiggle scales with its box
          d.t.w = nw; d.t.h = nh;
        }
        else if (d.mode === 'portalMove') { d.t.x = Math.round(m.x - d.dx); d.t.y = Math.round(m.y - d.dy); }
        else if (d.mode === 'portalR') { d.t.r = Math.max(30, Math.round(m.y - d.t.y)); }
        this.queueSave();
      });
      window.addEventListener('pointerup', () => {
        if (this.refDrag) { this.refDrag = null; this.queueSave(); return; }
        if (this.erasing) { this.erasing = false; this.build(); return; }
        if (this.draw) { this._finishStroke(); return; }
        if (this.platStroke) { this._finishPlatStroke(this._stage()); return; }
        if (this.drag) { this.drag = null; this.build(); }
      });
      // scroll to resize the reference image while in "Move reference" mode
      cv.addEventListener('wheel', (e) => {
        if (!this.active || this.subtab !== 'draw' || !this.refMove || !this._refReady()) return;
        e.preventDefault();
        this.traceScale = Math.max(0.02, Math.min(0.6, this.traceScale * (e.deltaY < 0 ? 1.08 : 0.926)));
        this.queueSave();
      }, { passive: false });
    }

    // ---------- render (main canvas while in editor) ----------
    render(cssW, cssH) {
      const ctx = this.game.ctx;
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.fillStyle = D.COL.paperShade; ctx.fillRect(0, 0, cssW, cssH);
      if (this.subtab === 'stage') { this._renderStageTab(ctx, cssW, cssH); return; } // its own fit-to-map view
      this.game._applyView(cssW, cssH);
      ctx.save();
      ctx.translate(this.game.ox, this.game.oy); ctx.scale(this.game.scale, this.game.scale);
      ctx.beginPath(); ctx.rect(0, 0, this.data.view.w, this.data.view.h); ctx.clip();
      ctx.drawImage(D.paperTexture(this.data.view.w, this.data.view.h), 0, 0);

      if (this.subtab === 'draw') this._renderDrawTab(ctx);
      else { DS.stage.drawBackground(ctx, this.data); DS.stage.drawStage(ctx, this.data); } // settings preview
      ctx.restore();
    }

    _refReady() { return !!(this.traceLoaded && this.traceImg && this.traceImg.naturalWidth); }

    _renderDrawTab(ctx) {
      const ch = this.data.characters[this.charName]; this._ensureSkin(ch);
      const cx = this.data.view.w / 2, cy = this.data.view.h / 2, Z = this.Z;
      const rnd = DS.makeRng(7);
      const posing = this.refMove && this._refReady();

      ctx.save();
      ctx.translate(cx, cy); ctx.scale(Z, Z);
      // optional reference image to trace over, imprinted faint behind everything
      if (this._refReady()) {
        const iw = this.traceImg.naturalWidth, ih = this.traceImg.naturalHeight, s = this.traceScale;
        ctx.save(); ctx.globalAlpha = this.traceAlpha;
        ctx.drawImage(this.traceImg, -iw * s / 2 + this.traceX, -ih * s / 2 + this.traceY, iw * s, ih * s);
        ctx.restore();
      }
      // faint ghost body to draw over (active part highlighted)
      DS.skin.drawMannequin(ctx, this.drawMode);
      // the strokes drawn so far (shifted by the drawing's vertical offset, matching in-game)
      ctx.save(); if (ch.skin.offsetY) ctx.translate(0, ch.skin.offsetY);
      DS.skin.PARTS.forEach((name) => {
        const pt = ch.skin.parts[name]; if (!pt.strokes.length) return;
        ctx.save(); ctx.translate(DS.skin.PIVOTS[name].x, DS.skin.PIVOTS[name].y);
        DS.skin.drawStrokes(ctx, pt.strokes, rnd); ctx.restore();
      });
      ctx.restore();
      // the stroke currently being drawn (accent colour)
      if (this.draw && this.draw.pts.length) {
        DS.draw.strokePts(ctx, this.draw.pts, { width: this.draw.w, color: DS.draw.COL.accent, rnd, jitter: 0.3, passes: 1 });
      }
      ctx.restore();

      ctx.fillStyle = D.COL.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = "30px 'Gloria Hallelujah', cursive";
      ctx.fillText((posing ? 'Position reference: ' : 'Drawing: ') + this.charName, cx, 64);
      ctx.fillStyle = D.COL.inkSoft; ctx.font = "22px 'Patrick Hand', cursive";
      ctx.fillText(posing ? 'drag the picture to move · scroll to resize'
        : (this.drawMode === 'auto' ? 'strokes auto-sort into body parts' : 'drawing into: ' + this.drawMode), cx, 92);
    }


    // Stage tab: frame the WHOLE selected map (it can be far bigger than the 1920x1080 view),
    // render its real scenery + platforms + spawns, plus draggable edit handles.
    _renderStageTab(ctx, cssW, cssH) {
      ctx.drawImage(D.paperTexture(cssW, cssH), 0, 0); // one continuous paper sheet, like in-game
      const st = this._stage(), ext = this._ext(st), sv = this._stageView(cssW, cssH, ext);
      this._sv = sv;
      ctx.save();
      ctx.translate(sv.ox, sv.oy); ctx.scale(sv.scale, sv.scale);
      DS.stage.drawBackground(ctx, st);
      DS.stage.drawStage(ctx, st);
      // the play-bounds the camera/KO use (dashed guide) so big stages read clearly
      if (st.bounds) {
        ctx.save(); ctx.strokeStyle = 'rgba(47,42,38,0.3)'; ctx.setLineDash([11 / sv.scale, 9 / sv.scale]); ctx.lineWidth = 2 / sv.scale;
        ctx.strokeRect(st.bounds.x0, st.bounds.y0, st.bounds.x1 - st.bounds.x0, st.bounds.y1 - st.bounds.y0); ctx.setLineDash([]); ctx.restore();
      }
      this._renderStageHandles(ctx, st, sv);
      // the platform currently being traced (accent), at the same chunk-width it'll become
      if (this.platStroke && this.platStroke.pts.length) {
        D.strokePts(ctx, this.platStroke.pts, { width: 16, color: D.COL.accent, rnd: DS.makeRng(3), jitter: 0.2, passes: 1 });
      }
      ctx.restore();
      ctx.fillStyle = D.COL.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = "26px 'Gloria Hallelujah', cursive";
      ctx.fillText('Editing: ' + (st.name || DS.Maps.get(this.editMap).name), cssW / 2, 34);
    }
    // dashed boxes + resize nubs on platforms, dotted circles on spawns (sizes kept ~constant on screen)
    _renderStageHandles(ctx, st, sv) {
      const s = sv.scale;
      for (const pl of st.platforms) {
        const sel = pl === this.selPlat;
        ctx.save();
        ctx.strokeStyle = sel ? D.COL.accent : 'rgba(47,42,38,0.35)';
        ctx.setLineDash([6 / s, 6 / s]); ctx.lineWidth = 2 / s;
        ctx.strokeRect(pl.x, pl.y, pl.w, pl.h);
        ctx.setLineDash([]);
        if (sel) { const h = 12 / s; ctx.fillStyle = D.COL.accent; ctx.fillRect(pl.x + pl.w - h * 0.75, pl.y + pl.h - h * 0.75, h, h); }
        ctx.restore();
      }
      st.spawns.forEach((sp, i) => {
        ctx.save(); ctx.strokeStyle = D.COL.accent; ctx.setLineDash([4 / s, 5 / s]); ctx.lineWidth = 2.5 / s;
        ctx.beginPath(); ctx.arc(sp.x, sp.y, 14 / s, 0, 7); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = D.COL.accent; ctx.font = (20 / s) + "px 'Patrick Hand'"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('P' + (i + 1), sp.x, sp.y); ctx.restore();
      });
      // portals: a selection ring + a radius nub at the bottom (the glyph itself is drawn by drawStage)
      for (const pt of st.portals || []) {
        const sel = pt === this.selPortal;
        ctx.save();
        ctx.strokeStyle = sel ? D.COL.accent : 'rgba(47,42,38,0.4)';
        ctx.setLineDash([5 / s, 5 / s]); ctx.lineWidth = 2 / s;
        ctx.beginPath(); ctx.ellipse(pt.x, pt.y, pt.r * 0.72, pt.r, 0, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
        const hh = 12 / s; ctx.fillStyle = sel ? D.COL.accent : 'rgba(47,42,38,0.4)';
        ctx.fillRect(pt.x - hh / 2, pt.y + pt.r - hh / 2, hh, hh);
        ctx.restore();
      }
    }

    _renderCharPreview(ctx) {
      const ch = this.data.characters[this.charName];
      const act = ch.actions[this.action];
      const cScale = ch.stats.scale || 1;
      const view = this.data.view;
      const cx = view.w / 2, cy = view.h / 2 - 20;       // fighter center
      const PV = 3.2;                                     // preview zoom
      const feetY = cy + 38 * PV * cScale;                // local feet ~ +38

      const rnd = DS.makeRng(5);
      // clean baseline + soft shadow (no stage clutter behind the character)
      D.line(ctx, cx - 200, feetY, cx + 200, feetY, { width: 4, color: D.COL.inkSoft, rnd, passes: 1 });
      ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = D.COL.ink;
      ctx.beginPath(); ctx.ellipse(cx, feetY, 64 * cScale, 11, 0, 0, 7); ctx.fill(); ctx.restore();

      ctx.save(); ctx.translate(cx, cy); ctx.scale(PV, PV);
      // the speed-moves morph into a weapon — show that art (with the pose faint behind it)
      const weaponKind = this.action === 'supershot' ? 'cannon'
        : (this.action === 'superpunch' || this.action === 'ultrapunch') ? 'glove'
          : this.action === 'hammer' ? 'hammer' : null;
      ctx.save();
      // glove/cannon are full-body MORPHS → show the body faint behind the weapon; the hammer
      // is a held prop → keep the body solid (matches how each looks in game)
      if (weaponKind === 'glove' || weaponKind === 'cannon') ctx.globalAlpha = 0.28;
      DS.character.drawFighter(ctx, ch, act.pose, { facing: 1, seed: 7,
        expr: this.action === 'attack' || this.action === 'special' ? 'attack' : this.action === 'hurt' ? 'hurt' : this.action === 'shield' ? 'shield' : '' });
      ctx.restore();
      if (weaponKind) {
        DS.character.weapon(ctx, weaponKind, { dir: 1, big: this.action === 'ultrapunch', scale: cScale, swing: 0.85 });
      }
      if (act.hit) { // hitbox preview (in the same local space the hit is checked)
        const h = act.hit;
        ctx.globalAlpha = 0.55; ctx.strokeStyle = D.COL.accent; ctx.lineWidth = 1.4;
        ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, 7); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
      ctx.restore();

      ctx.fillStyle = D.COL.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = "30px 'Gloria Hallelujah', cursive";
      ctx.fillText(this.charName, cx, 80);
    }
  }

  DS.Editor = Editor;
})(window);
