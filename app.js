(function () {
  'use strict';
  const C = window.VistoriaCore;
  const KEY = 'vistoria.v1';
  const DAY = 86400000;
  const $ = id => document.getElementById(id);

  const ICON_MIC = '<svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM18 12a6 6 0 0 1-12 0M12 18v3"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/></svg>';
  const ICON_CAM = '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/></svg>';
  const ICON_MORE = '<svg viewBox="0 0 24 24"><path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3.2"/></svg>';
  const ICON_ARROW = '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  // ---------- estado ----------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function newVistoria() {
    const now = Date.now();
    return { id: uid(), title: 'Vistoria ' + C.fmtDate(now), created: now, items: [] };
  }

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && d.vistorias && d.vistorias.length) {
        // dados salvos por versões anteriores não têm os campos de encaminhamento
        if (!Array.isArray(d.dests) || !d.dests.length) d.dests = ['Manutenção'];
        if (d.currentDest === undefined) d.currentDest = null;
        if (d.currentPrio === undefined) d.currentPrio = null;
        return d;
      }
    } catch (e) { /* ignora */ }
    const v = newVistoria();
    return {
      sectors: C.DEFAULT_SECTORS.slice(), dests: ['Manutenção'],
      vistorias: [v], currentId: v.id, currentSector: 'Geral', currentDest: null
    };
  }

  let S = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Sem espaço para salvar'); }
  }
  function cur() { return S.vistorias.find(v => v.id === S.currentId) || S.vistorias[0]; }

  function findItem(id) {
    for (const v of S.vistorias) {
      const it = v.items.find(i => i.id === id);
      if (it) return { it, v };
    }
    return null;
  }

  // Notas encaminhadas (têm destino) de todas as visitas
  function allTracked() {
    const out = [];
    S.vistorias.forEach(v => v.items.forEach(it => { if (it.dest) out.push({ it, v }); }));
    return out;
  }
  const isOpen = it => !!it.dest && it.status !== 'done';
  const openCount = () => allTracked().filter(x => isOpen(x.it)).length;
  const openInOtherVisits = sector =>
    allTracked().filter(x => x.v.id !== S.currentId && isOpen(x.it) && x.it.sector === sector).length;

  function ageText(ts) {
    const d = Math.floor((Date.now() - ts) / DAY);
    return d <= 0 ? 'hoje' : d === 1 ? 'há 1 dia' : 'há ' + d + ' dias';
  }
  function plural(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }
  function isoLocal(ts) {
    const d = new Date(ts), p = x => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // cor de cada setor, estável pela posição na lista
  const PALETTE = ['#2f6fde', '#e4572e', '#12a594', '#e09f00', '#8e5bd6', '#d6336c', '#3e9b2f', '#b8643c', '#0e9ec4', '#7a8f1e', '#c026d3', '#0f5d8c'];
  function colorFor(name) {
    if (name === 'Geral') return '#6b7a90';
    const i = S.sectors.indexOf(name);
    return PALETTE[(i < 0 ? name.length : i) % PALETTE.length];
  }


  // ---------- fotos (IndexedDB) ----------
  // mini  = ~200 px, usada na tela (fica toda em memória, é leve)
  // thumb = ~600 px, usada no PDF (carregada só quando gera o PDF)
  // full  = ~1280 px, usada ao abrir a foto
  const TH = new Map();   // id -> { d, w, h }  minis em memória
  const MID = new Map();  // id -> { d, w, h }  cache das versões do PDF
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('vistoria-fotos', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        ['thumb', 'full', 'mini'].forEach(n => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function dbRun(stores, mode, fn) {
    return db().then(d => new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      let out;
      try { out = fn(t); } catch (e) { rej(e); return; }
      t.oncomplete = () => res(out && out.result);
      t.onerror = t.onabort = () => rej(t.error);
    }));
  }
  const STORES = ['mini', 'thumb', 'full'];
  function putPhoto(id, mini, thumb, full) {
    return dbRun(STORES, 'readwrite', t => {
      t.objectStore('mini').put({ id, d: mini.d, w: mini.w, h: mini.h });
      t.objectStore('thumb').put({ id, d: thumb.d, w: thumb.w, h: thumb.h });
      t.objectStore('full').put({ id, d: full.d });
    });
  }
  function delPhotoData(ids) {
    ids = (ids || []).filter(Boolean);
    ids.forEach(id => { TH.delete(id); MID.delete(id); });
    if (!ids.length) return;
    dbRun(STORES, 'readwrite', t => ids.forEach(id => STORES.forEach(n => t.objectStore(n).delete(id)))).catch(() => {});
  }
  const photosOf = items => [].concat(...items.map(i => i.photos || []));
  const allItems = () => [].concat(...S.vistorias.map(v => v.items));

  async function loadThumbs() {
    try {
      const minis = await dbRun(['mini'], 'readonly', t => t.objectStore('mini').getAll());
      (minis || []).forEach(r => TH.set(r.id, { d: r.d, w: r.w, h: r.h }));
      const keys = await dbRun(['thumb'], 'readonly', t => t.objectStore('thumb').getAllKeys());
      const used = new Set(photosOf(allItems()));
      const orphans = (keys || []).filter(id => !used.has(id));
      if (orphans.length) delPhotoData(orphans);
      render();
      if ($('dlgPend').open) renderPend();
      // fotos das versões anteriores não têm mini: cria agora, aos poucos
      const missing = (keys || []).filter(id => used.has(id) && !TH.has(id));
      for (const id of missing) {
        const r = await dbRun(['thumb'], 'readonly', t => t.objectStore('thumb').get(id));
        if (!r) continue;
        const im = await loadImg(r.d);
        const mini = shrink(im, 200, 0.7);
        await dbRun(['mini'], 'readwrite', t => t.objectStore('mini').put({ id, d: mini.d, w: mini.w, h: mini.h }));
        TH.set(id, mini);
      }
      if (missing.length) { render(); if ($('dlgPend').open) renderPend(); }
    } catch (e) { /* sem IndexedDB: segue sem fotos */ }
  }

  // carrega as versões de PDF das fotos destas notas
  async function loadMids(items) {
    const ids = photosOf(items).filter(id => !MID.has(id));
    if (!ids.length) return;
    try {
      const rows = await dbRun(['thumb'], 'readonly', t => {
        const st = t.objectStore('thumb'), out = [];
        ids.forEach(id => { const q = st.get(id); q.onsuccess = () => q.result && out.push(q.result); });
        return { get result() { return out; } };
      });
      (rows || []).forEach(r => MID.set(r.id, { d: r.d, w: r.w, h: r.h }));
    } catch (e) { /* usa a mini */ }
  }

  function loadImg(src) {
    return new Promise((res, rej) => {
      const isFile = typeof src !== 'string';
      const u = isFile ? URL.createObjectURL(src) : src, im = new Image();
      im.onload = () => { if (isFile) URL.revokeObjectURL(u); res(im); };
      im.onerror = () => { if (isFile) URL.revokeObjectURL(u); rej(new Error('img')); };
      im.src = u;
    });
  }
  function shrink(im, max, q) {
    const sc = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.max(1, Math.round(im.naturalWidth * sc)), h = Math.max(1, Math.round(im.naturalHeight * sc));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
    x.drawImage(im, 0, 0, w, h);
    return { d: c.toDataURL('image/jpeg', q), w, h };
  }

  async function addPhotos(files, targetId) {
    const f = findItem(targetId);
    if (!f || !files.length) return;
    let ok = 0;
    toast('Salvando foto…');
    for (const file of files) {
      try {
        const im = await loadImg(file);
        const mini = shrink(im, 200, 0.7), thumb = shrink(im, 600, 0.75), full = shrink(im, 1280, 0.7);
        const id = uid();
        await putPhoto(id, mini, thumb, full);
        TH.set(id, mini);
        MID.set(id, thumb);
        (f.it.photos = f.it.photos || []).push(id);
        ok++;
      } catch (e) { /* segue com as outras */ }
    }
    save(); render();
    if ($('dlgPend').open) renderPend();
    toast(ok ? (ok === 1 ? 'Foto anexada' : ok + ' fotos anexadas') + (ok < files.length ? ', mas ' + (files.length - ok) + ' falhou' : '') : 'Não consegui salvar a foto');
  }

  function picsHtml(it) {
    const ids = it.photos || [];
    if (!ids.length) return '';
    return '<div class="pics">' + ids.map(id => TH.has(id)
      ? `<button class="pic" data-pic="${id}" aria-label="Ver foto"><img src="${TH.get(id).d}" alt="Foto da nota" decoding="async"></button>`
      : '<span class="pic"></span>').join('') + '</div>';
  }
  const pdfPhoto = id => { const t = MID.get(id) || TH.get(id); return t ? { data: t.d, w: t.w, h: t.h } : null; };

  // ---------- biblioteca de PDF (carrega só quando precisa) ----------
  let pdfLib = null;
  function needPdf() {
    if (window.jspdf) return Promise.resolve();
    if (!pdfLib) pdfLib = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = 'jspdf.umd.min.js';
      sc.onload = () => res();
      sc.onerror = () => { pdfLib = null; rej(new Error('pdf')); };
      document.head.appendChild(sc);
    });
    return pdfLib;
  }
  async function preparePdf(items) {
    try { await needPdf(); } catch (e) { toast('A biblioteca de PDF não carregou'); return false; }
    await loadMids(items);
    return true;
  }

  // ---------- previsão ----------
  function shortDate(ts) { const d = new Date(ts), p = x => String(x).padStart(2, '0'); return p(d.getDate()) + '/' + p(d.getMonth() + 1); }
  const PRIO_L = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
  function fcState(it) { return C.forecastState(it, Date.now()); }
  const lateCount = () => allTracked().filter(x => { const f = fcState(x.it); return f && f.late; }).length;
  function dia(n) { return n + (n === 1 ? ' dia' : ' dias'); }

  // ---------- UI ----------
  let toastT, toastFn = null;
  function toast(msg, action, fn) {
    const t = $('toast');
    t.innerHTML = '';
    t.appendChild(document.createTextNode(msg));
    toastFn = null;
    if (action) {
      const b = document.createElement('button');
      b.textContent = action;
      t.appendChild(b);
      toastFn = fn;
    }
    t.classList.toggle('act', !!action);
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.classList.remove('show', 'act'); toastFn = null; }, action ? 5500 : 2300);
  }
  $('toast').addEventListener('click', e => {
    if (!e.target.closest('button') || !toastFn) return;
    const fn = toastFn;
    toastFn = null;
    $('toast').classList.remove('show', 'act');
    fn();
  });

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderHeader() {
    const v = cur();
    $('title').value = v.title;
    const n = v.items.length;
    const g = C.groupItems(v.items, S.sectors).length;
    const f = v.items.filter(i => i.dest).length;
    const lt = v.items.filter(i => { const x = fcState(i); return x && x.late; }).length;
    $('stats').textContent = n
      ? `${plural(n, 'nota', 'notas')} em ${plural(g, 'setor', 'setores')}` + (f ? `, ${plural(f, 'encaminhada', 'encaminhadas')}` : '') +
        (lt ? `, ${plural(lt, 'atrasada', 'atrasadas')}` : '')
      : 'Nenhuma nota ainda';
    $('sectorName').textContent = S.currentSector;
    $('sectorDot').style.background = colorFor(S.currentSector);

    $('destVal').textContent = S.currentDest ? S.currentDest + (S.currentPrio ? ', ' + PRIO_L[S.currentPrio].toLowerCase() : '') : 'Nenhum';
    $('destBar').classList.toggle('on', !!S.currentDest);

    const other = openInOtherVisits(S.currentSector);
    $('banner').style.display = other ? '' : 'none';
    $('bannerTxt').textContent = `${S.currentSector}: ${plural(other, 'pendência aberta', 'pendências abertas')} de visitas anteriores`;

    const oc = openCount();
    $('badge').textContent = oc > 99 ? '99+' : oc;
    $('badge').style.display = oc ? '' : 'none';
    $('badge').classList.toggle('late', lateCount() > 0);
    $('btnHist').classList.toggle('warn', backupDue());
  }

  // Resumo da nota: só mostra o que existe; as ações ficam no menu "⋯"
  function noteChips(i) {
    if (!i.dest) return '';
    const done = i.status === 'done';
    const d = C.openDays(i.ts, Date.now());
    let h = `<button class="tag" data-dest aria-label="Mudar encaminhamento">${ICON_ARROW}${esc(i.dest)}</button>`;
    if (i.prio) h += `<button class="pr ${i.prio}" data-pr>${PRIO_L[i.prio]}</button>`;
    if (done) return h + '<span class="st done">Resolvida</span>';
    const f = fcState(i);
    if (f && f.late) return h + `<button class="fc late" data-fc>Atrasada ${dia(f.days)}</button>`;
    h += `<span class="st open">${d === 0 ? 'Aberta hoje' : 'Aberta há ' + dia(d)}</span>`;
    if (f) h += `<button class="fc" data-fc>Previsto ${f.left === 0 ? 'para hoje' : shortDate(i.forecast)}</button>`;
    return h;
  }

  function renderList() {
    const v = cur();
    const groups = C.groupItems(v.items, S.sectors);
    if (!groups.length) {
      $('list').innerHTML = `<div class="empty"><div class="ring">${ICON_MIC}</div>
        <b>Segure o botão amarelo e fale.</b><br>Solte para guardar a nota no setor escolhido.</div>`;
      return;
    }
    const opts = sel => S.sectors.concat(S.sectors.includes(sel) ? [] : [sel])
      .map(s => `<option${s === sel ? ' selected' : ''}>${esc(s)}</option>`).join('');
    $('list').innerHTML = groups.map(g => `
      <section class="group">
        <div class="ghead"><i style="background:${colorFor(g.name)}"></i><h2>${esc(g.name)}</h2><span>${g.items.length}</span></div>
        ${g.items.map(i => {
          const f = fcState(i);
          return `
          <div class="note${f && f.late ? ' late' : ''}" data-id="${i.id}" style="--c:${colorFor(i.sector)}">
            <div class="ntxt" contenteditable="true" spellcheck="false">${esc(i.text)}</div>
            ${picsHtml(i)}
            <div class="nmeta">
              <div class="nleft">
                <label class="pillwrap"><span class="d"></span><select data-move aria-label="Mudar de setor">${opts(i.sector)}</select></label>
                ${noteChips(i)}
              </div>
              <div class="nend">
                <span class="time">${i.nt ? '' : C.fmtTime(i.ts)}</span>
                <button class="more" data-more aria-label="Ações da nota">${ICON_MORE}</button>
              </div>
            </div>
          </div>`; }).join('')}
      </section>`).join('');
  }

  function render() { renderHeader(); renderList(); }

  // ---------- notas ----------
  function addItem(text, sector, prio) {
    const it = { id: uid(), sector: sector || S.currentSector, text, ts: Date.now() };
    if (S.currentDest) { it.dest = S.currentDest; it.status = 'open'; }
    const p = prio || (it.dest ? S.currentPrio : null);
    if (p) {
      // falar a prioridade já encaminha (para o destino escolhido ou o primeiro da lista)
      if (!it.dest) { it.dest = S.dests[0] || 'Manutenção'; it.status = 'open'; }
      it.prio = p;
    }
    cur().items.push(it);
    save();
  }

  function setSector(name) {
    if (!S.sectors.includes(name)) S.sectors.push(name);
    S.currentSector = name;
  }

  // Recebe o texto completo de uma gravação (ou digitado) e cria a nota.
  function handleSpeech(raw) {
    const r = C.parseSegment(raw, S.sectors);
    if (r.sector) {
      setSector(r.sector);
      toast('Setor: ' + r.sector + (r.newSector ? ' (novo)' : ''));
    }
    let said = null;
    r.items.forEach(t => {
      const pr = C.parsePrio(t);
      if (!pr.text) return;
      if (pr.prio) said = pr.prio;
      addItem(pr.text, null, pr.prio);
    });
    if (said) {
      const last = cur().items[cur().items.length - 1];
      toast('Prioridade ' + PRIO_L[said].toLowerCase() + ', encaminhada para ' + last.dest);
    }
    save();
    render();
    scrollToEnd();
  }

  function scrollToEnd() {
    const m = $('list');
    setTimeout(() => { m.scrollTop = m.scrollHeight; }, 30);
  }

  // ---------- seletor de setor ----------
  function renderSectorGrid() {
    const counts = {};
    cur().items.forEach(i => { counts[i.sector] = (counts[i.sector] || 0) + 1; });
    $('sectorGrid').innerHTML = S.sectors.map(s => `
      <button class="tile${s === S.currentSector ? ' on' : ''}" data-s="${esc(s)}">
        <i style="background:${colorFor(s)}"></i><b>${esc(s)}</b>${counts[s] ? `<small>${counts[s]}</small>` : ''}
      </button>`).join('') + '<button class="tile add" data-add="1">Novo setor</button>';
  }
  $('sectorBtn').onclick = () => { renderSectorGrid(); $('dlgSector').showModal(); };
  $('sectorClose').onclick = () => $('dlgSector').close();
  $('sectorGrid').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.add) {
      const name = (prompt('Nome do novo setor:') || '').trim();
      if (!name) return;
      setSector(C.titleCase(name));
    } else {
      S.currentSector = b.dataset.s;
    }
    save(); render();
    $('dlgSector').close();
  };

  // ---------- encaminhamento (destino) ----------
  let destTarget = null; // null = escolha fixa para as próximas notas; senão o id da nota

  function renderDestGrid() {
    const found = destTarget ? findItem(destTarget) : null;
    const sel = destTarget ? (found && found.it.dest) || null : S.currentDest;
    const open = {};
    allTracked().forEach(x => { if (isOpen(x.it)) open[x.it.dest] = (open[x.it.dest] || 0) + 1; });
    $('destGrid').innerHTML =
      `<button class="tile${!sel ? ' on' : ''}" data-d=""><i style="background:#9aa6b8"></i><b>Nenhum</b></button>` +
      S.dests.map(d => `
        <button class="tile${d === sel ? ' on' : ''}" data-d="${esc(d)}">
          <i style="background:var(--yellow-d)"></i><b>${esc(d)}</b>${open[d] ? `<small>${open[d]}</small>` : ''}
        </button>`).join('') +
      '<button class="tile add" data-add="1">Novo destino</button>';
    $('destPrioWrap').style.display = destTarget ? 'none' : '';
    $('destPrio').innerHTML = [['', 'Nenhuma'], ['alta', 'Alta'], ['media', 'Média'], ['baixa', 'Baixa']].map(([k, l]) =>
      `<button class="chip${(S.currentPrio || '') === k ? ' on' : ''}${k ? ' p-' + k : ''}" data-p="${k}">${l}</button>`).join('');
  }
  $('destPrio').onclick = e => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    S.currentPrio = b.dataset.p || null;
    save(); renderDestGrid(); renderHeader();
  };

  function openDest(target) {
    destTarget = target;
    $('destTitle').textContent = target ? 'Encaminhar esta nota' : 'Encaminhar para';
    $('destTip').textContent = target ? '' :
      'As próximas notas já saem encaminhadas, com a prioridade escolhida, e ficam em aberto até você conferir. Volte para "Nenhum" quando terminar.';
    renderDestGrid();
    $('dlgDest').showModal();
  }

  function applyDest(name) {
    if (!destTarget) { S.currentDest = name; if (!name) S.currentPrio = null; return; }
    const f = findItem(destTarget);
    if (!f) return;
    if (name) {
      if (f.it.dest !== name) { f.it.dest = name; f.it.status = 'open'; delete f.it.doneAt; delete f.it.forecast; delete f.it.fcPrev; }
    } else {
      delete f.it.dest; delete f.it.status; delete f.it.doneAt; delete f.it.rechecks; delete f.it.forecast; delete f.it.fcPrev; delete f.it.prio;
    }
  }

  $('destBar').onclick = () => openDest(null);
  $('destClose').onclick = () => $('dlgDest').close();
  $('destGrid').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    let name;
    if (b.dataset.add) {
      const typed = (prompt('Nome do destino (ex.: Equipe de apoio):') || '').trim();
      if (!typed) return;
      name = C.resolveSector(typed, S.dests, false);
      if (!S.dests.includes(name)) S.dests.push(name);
    } else {
      name = b.dataset.d || null;
    }
    applyDest(name);
    save(); render();
    if ($('dlgPend').open) renderPend();
    $('dlgDest').close();
    // encaminhou uma nota sem prioridade: já pergunta a prioridade
    const f = destTarget && name ? findItem(destTarget) : null;
    if (f && !f.it.prio) openPrio(destTarget);
  };

  // ---------- pendências (conferir na volta) ----------
  const P = { dest: null, status: 'open', sector: null };

  function openPend(f) {
    P.status = 'open';
    if (f) { P.sector = f.sector || null; P.dest = f.dest !== undefined ? f.dest : P.dest; }
    else P.sector = null;
    renderPend();
    $('dlgPend').showModal();
  }

  const PRANK = { alta: 0, media: 1, baixa: 2 };
  function pendRows() {
    return allTracked()
      .filter(({ it }) =>
        (!P.dest || it.dest === P.dest) &&
        (!P.sector || it.sector === P.sector) &&
        (P.status === 'all' ||
          (P.status === 'late' ? !!(fcState(it) && fcState(it).late) : (P.status === 'open') === (it.status !== 'done'))))
      .sort((a, b) => (PRANK[a.it.prio] ?? 3) - (PRANK[b.it.prio] ?? 3) || a.it.ts - b.it.ts);
  }

  function pItemHtml(r) {
    const it = r.it, done = it.status === 'done', rc = it.rechecks || [];
    const fs = fcState(it);
    let h = `<div class="pitem${done ? ' done' : ''}${fs && fs.late ? ' late' : ''}" data-id="${it.id}"><div class="ptxt">${esc(it.text)}</div>`;
    h += picsHtml(it);
    if (it.prio) h += `<div class="pmeta"><span class="pr ${it.prio}" style="padding:3px 9px;font-size:12px">Prioridade ${PRIO_L[it.prio].toLowerCase()}</span></div>`;
    h += `<div class="pmeta"><b>${esc(it.dest)}</b>, registrada em ${C.fmtDate(it.ts)}${done ? '' : ' (' + ageText(it.ts) + ')'}</div>`;
    if (!done) {
      if (fs && fs.late) h += `<div class="pwarn">Atrasada ${dia(fs.days)}: a previsão era ${C.fmtDate(it.forecast)}</div>`;
      else if (fs) h += `<div class="pfc">Previsão de resolução: ${C.fmtDate(it.forecast)}${fs.left === 0 ? ' (hoje)' : fs.left === 1 ? ' (amanhã)' : ''}</div>`;
      else h += '<div class="pmeta">Sem previsão de resolução ainda</div>';
    }
    if (done) h += `<div class="pok">Resolvida${it.doneAt ? ' em ' + C.fmtDate(it.doneAt) : ''}</div>`;
    else if (rc.length) h += `<div class="pwarn">Conferida ${rc.length}x e continua aberta, última em ${C.fmtDate(rc[rc.length - 1])}</div>`;
    h += '<div class="pact">' + (done
      ? '<button data-act="reopen">Reabrir</button>'
      : '<button class="go" data-act="done">Resolvido</button><button class="no" data-act="still">Continua aberto</button>') + '</div>' +
      '<div class="pact two">' + (done ? '' : '<button data-fc>Previsão</button>') + '<button data-pr>Prioridade</button><button data-photo>Foto</button></div></div>';
    return h;
  }

  function renderPend() {
    const all = allTracked();
    const openBy = d => all.filter(x => x.it.dest === d && isOpen(x.it)).length;
    const destChips = `<button class="chip${!P.dest ? ' on' : ''}" data-fd="">Todos</button>` +
      S.dests.map(d => {
        const n = openBy(d);
        return `<button class="chip${P.dest === d ? ' on' : ''}" data-fd="${esc(d)}">${esc(d)}${n ? ' (' + n + ')' : ''}</button>`;
      }).join('');
    const nLate = lateCount();
    const statusChips = [['open', 'Abertas'], ['late', 'Atrasadas' + (nLate ? ' (' + nLate + ')' : '')], ['done', 'Resolvidas'], ['all', 'Todas']]
      .map(([k, l]) => `<button class="chip${P.status === k ? ' on' : ''}" data-fst="${k}">${l}</button>`).join('');
    $('pendFilters').innerHTML =
      `<div class="fl">${destChips}</div><div class="fl">${statusChips}</div>` +
      (P.sector ? `<div class="fl"><button class="chip x" data-fsec>Setor: ${esc(P.sector)} ×</button></div>` : '');

    const rows = pendRows();
    if (!rows.length) {
      $('pendList').innerHTML = '<div class="pend-empty">' + (P.status === 'open'
        ? '<b>Nenhuma pendência aberta.</b><br>Encaminhe uma nota para uma área (ex.: Manutenção) e ela fica aqui até você conferir.'
        : 'Nada por aqui.') + '</div>';
    } else {
      const groups = C.groupItems(rows.map(r => ({ sector: r.it.sector, r })), S.sectors);
      $('pendList').innerHTML = groups.map(g => `
        <section class="pgroup">
          <h3><i style="background:${colorFor(g.name)}"></i>${esc(g.name)}<span>${g.items.length}</span></h3>
          ${g.items.map(i => pItemHtml(i.r)).join('')}
        </section>`).join('');
    }
    $('pendPdf').textContent = P.dest ? 'Gerar PDF para ' + P.dest : 'Gerar PDF das pendências';
  }

  $('btnPend').onclick = () => openPend();
  $('banner').onclick = () => openPend({ sector: S.currentSector, dest: null });
  $('pendClose').onclick = () => $('dlgPend').close();

  $('pendFilters').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    if ('fd' in b.dataset) P.dest = b.dataset.fd || null;
    else if (b.dataset.fst) P.status = b.dataset.fst;
    else if ('fsec' in b.dataset) P.sector = null;
    renderPend();
  };

  $('pendList').onclick = e => {
    const rowEl = e.target.closest('.pitem');
    if (rowEl) {
      const id = rowEl.dataset.id;
      if (e.target.closest('[data-pic]')) { viewPhoto(e.target.closest('[data-pic]').dataset.pic, id); return; }
      if (e.target.closest('[data-photo]')) { openPhoto(id); return; }
      if (e.target.closest('[data-fc]')) { openFc(id); return; }
      if (e.target.closest('[data-pr]')) { openPrio(id); return; }
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const f = findItem(b.closest('.pitem').dataset.id);
    if (!f) return;
    const it = f.it, act = b.dataset.act;
    if (act === 'done') {
      it.status = 'done'; it.doneAt = Date.now();
    } else if (act === 'still') {
      const rc = it.rechecks || [];
      if (rc.length && Date.now() - rc[rc.length - 1] < 5 * 60000) { toast('Já anotado agora há pouco'); return; }
      it.rechecks = rc.concat(Date.now());
      toast('Anotado: continua aberto');
    } else if (act === 'reopen') {
      it.status = 'open'; delete it.doneAt;
    }
    save(); render(); renderPend();
  };

  $('pendPdf').onclick = async () => {
    const rows = pendRows();
    if (!rows.length) { toast('Nada para colocar no relatório'); return; }
    if (!(await preparePdf(rows.map(r => r.it)))) return;
    const now = Date.now();
    const heading = P.dest ? 'Relatório para ' + P.dest : 'Relatório de pendências';
    const nSec = new Set(rows.map(r => r.it.sector)).size;
    const what = P.status === 'open' ? plural(rows.length, 'pendência', 'pendências') : plural(rows.length, 'item', 'itens');
    const fake = {
      title: heading + ' ' + C.fmtDate(now), created: now,
      items: rows.map(r => ({ sector: r.it.sector, text: r.it.text, ts: r.it.ts, dest: r.it.dest, status: r.it.status, doneAt: r.it.doneAt,
        rechecks: r.it.rechecks, prio: r.it.prio, forecast: r.it.forecast, fcPrev: r.it.fcPrev, photos: r.it.photos }))
    };
    const doc = C.buildPdf(window.jspdf.jsPDF, fake, S.sectors, {
      heading, embed: false,
      subtitle: `Emitido em ${C.fmtDate(now)}  •  ${what} em ${plural(nSec, 'setor', 'setores')}`,
      summary: maintSummary(fake.items, P.dest),
      photo: pdfPhoto,
      meta: i => C.maintMeta(i, now, !P.dest)
    });
    showPdf(doc, 'Pendencias_' + (C.norm(P.dest || 'todas').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) + '_' + isoLocal(now) + '.pdf');
  };

  // ---------- reconhecimento de voz (segurar para gravar) ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const dock = $('dock'), mic = $('mic');
  let rec = null, recording = false, locked = false, pendingFinish = false;
  let discardReason = null, finishT = null, tailT = null, wake = null, timerI = null;
  let buf = '';   // texto das partes já encerradas desta gravação
  let part = '';  // texto da parte em andamento
  let startX = 0, pressAt = 0, cancelArmed = false;

  const CANCEL_PX = 90;   // quanto deslizar para a esquerda para cancelar
  const MIN_HOLD = 350;   // toque mais curto que isso não grava
  const TAIL_MS = 350;    // folga depois de soltar, para não cortar a última palavra

  function mmss(ms) {
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function showLive() {
    const t = (buf + ' ' + part).trim();
    const card = $('livecard');
    card.classList.toggle('empty-state', !t);
    $('live').textContent = t || 'Pode falar…';
    card.scrollTop = card.scrollHeight;
  }

  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator) wake = await navigator.wakeLock.request('screen');
      else if (wake) { await wake.release(); wake = null; }
    } catch (e) { /* ok */ }
  }

  function setCancel(on) {
    cancelArmed = on;
    dock.classList.toggle('cancel', on);
    $('recHint').textContent = on ? 'Solte para cancelar' : '‹ deslize para cancelar';
  }

  function startRec() {
    if (!SR) { toast('Este navegador não tem reconhecimento de voz'); return false; }
    if (recording || locked) return false;
    buf = ''; part = ''; discardReason = null; pendingFinish = false;
    rec = new SR();
    rec.lang = 'pt-BR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = e => {
      const list = [];
      for (let i = 0; i < e.results.length; i++) list.push(e.results[i][0].transcript);
      part = C.mergeResults(list);
      showLive();
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        abortAll();
        toast('Permita o microfone nas configurações do site');
      } else if (e.error === 'audio-capture') {
        abortAll();
        toast('Microfone indisponível');
      } else if (e.error === 'network') {
        toast('Sem internet: a transcrição precisa de conexão');
      }
    };
    rec.onend = () => {
      // O Chrome encerra sozinho após alguns segundos de silêncio: guarda a parte e reinicia.
      buf = (buf + ' ' + part).trim();
      part = '';
      if (recording) { try { rec.start(); } catch (err) { /* já iniciando */ } }
      else finish();
    };

    try { rec.start(); } catch (err) { toast('Não consegui iniciar o microfone'); return false; }
    recording = true;
    pressAt = Date.now();
    setCancel(false);
    dock.classList.add('recording');
    mic.classList.add('rec');
    $('timer').textContent = '0:00';
    clearInterval(timerI);
    timerI = setInterval(() => { $('timer').textContent = mmss(Date.now() - pressAt); }, 250);
    keepAwake(true);
    showLive();
    if (navigator.vibrate) navigator.vibrate(15);
    return true;
  }

  // Falha ou permissão negada: volta tudo ao normal sem criar nota.
  function abortAll() {
    recording = false; locked = false; pendingFinish = false;
    clearInterval(timerI); clearTimeout(finishT); clearTimeout(tailT);
    buf = ''; part = '';
    dock.classList.remove('recording', 'cancel');
    mic.classList.remove('rec');
    keepAwake(false);
    try { rec && rec.abort(); } catch (e) { /* ok */ }
  }

  // Soltou o botão: fecha a gravação e cria UMA nota (ou descarta).
  function release() {
    if (!recording) return;
    const held = Date.now() - pressAt;
    if (cancelArmed) discardReason = 'slide';
    else if (held < MIN_HOLD) discardReason = 'short';
    recording = false;
    locked = true;
    pendingFinish = true;
    clearInterval(timerI);
    mic.classList.remove('rec');
    keepAwake(false);
    if (navigator.vibrate) navigator.vibrate(10);
    tailT = setTimeout(() => { try { rec && rec.stop(); } catch (e) { /* ok */ } }, discardReason ? 0 : TAIL_MS);
    finishT = setTimeout(finish, 2200); // garantia, caso o onend demore
  }

  function finish() {
    if (!pendingFinish) return;
    pendingFinish = false;
    clearTimeout(finishT); clearTimeout(tailT);
    const text = (buf + ' ' + part).replace(/\s+/g, ' ').trim();
    buf = ''; part = '';
    dock.classList.remove('recording', 'cancel');
    locked = false;
    cancelArmed = false;
    try { rec && rec.abort(); } catch (e) { /* ok */ }

    if (discardReason === 'short') toast('Segure o botão para gravar');
    else if (discardReason === 'slide') toast('Gravação descartada');
    else if (text) handleSpeech(text);
    else toast('Nada foi captado');
  }

  mic.addEventListener('pointerdown', e => {
    if (e.button !== undefined && e.button > 0) return;
    e.preventDefault();
    try { mic.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
    startX = e.clientX;
    startRec();
  });
  mic.addEventListener('pointermove', e => {
    if (!recording) return;
    const shouldCancel = (startX - e.clientX) > CANCEL_PX;
    if (shouldCancel !== cancelArmed) setCancel(shouldCancel);
  });
  mic.addEventListener('pointerup', release);
  mic.addEventListener('pointercancel', release);
  mic.addEventListener('contextmenu', e => e.preventDefault());
  // Teclado / leitor de tela: Enter ou Espaço alterna gravar e parar.
  mic.addEventListener('click', e => {
    if (e.detail !== 0) return;
    if (recording) { pressAt = Date.now() - MIN_HOLD - 1; release(); } else startRec();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { render(); if ($('dlgPend').open) renderPend(); }
    if (document.visibilityState === 'visible' && recording) keepAwake(true);
    if (document.visibilityState === 'hidden' && recording) release();
  });

  // ---------- digitar ----------
  function syncTyping() { dock.classList.toggle('typing', $('txt').value.trim().length > 0); }
  function typed() {
    const t = $('txt').value.trim();
    if (!t) return;
    $('txt').value = '';
    syncTyping();
    handleSpeech(t);
  }
  $('txt').addEventListener('input', syncTyping);
  $('send').onclick = typed;
  $('txt').addEventListener('keydown', e => { if (e.key === 'Enter') typed(); });

  // ---------- edição das notas ----------
  $('title').addEventListener('input', () => { cur().title = $('title').value.trim() || 'Vistoria'; save(); });

  $('list').addEventListener('focusout', e => {
    const t = e.target.closest('.ntxt');
    if (!t) return;
    const id = t.closest('.note').dataset.id;
    const it = cur().items.find(i => i.id === id);
    const txt = t.textContent.trim();
    if (!it) return;
    if (!txt) { deleteItem(id); return; }
    if (txt !== it.text) { it.text = txt; save(); }
  });
  $('list').addEventListener('change', e => {
    if (!e.target.matches('[data-move]')) return;
    const id = e.target.closest('.note').dataset.id;
    const it = cur().items.find(i => i.id === id);
    if (it) { it.sector = e.target.value; save(); render(); }
  });
  $('list').addEventListener('click', e => {
    const d = e.target.closest('[data-dest]');
    if (d) { openDest(d.closest('.note').dataset.id); return; }
    const pc = e.target.closest('[data-pic]');
    if (pc) { viewPhoto(pc.dataset.pic, pc.closest('.note').dataset.id); return; }
    const ph = e.target.closest('[data-photo]');
    if (ph) { openPhoto(ph.closest('.note').dataset.id); return; }
    const pb = e.target.closest('[data-pr]');
    if (pb) { openPrio(pb.closest('.note').dataset.id); return; }
    const fc = e.target.closest('[data-fc]');
    if (fc) { openFc(fc.closest('.note').dataset.id); return; }
    const mo = e.target.closest('[data-more]');
    if (mo) openMore(mo.closest('.note').dataset.id);
  });

  // Exclui com opção de desfazer (as fotos só são apagadas depois que o aviso some)
  function deleteItem(id) {
    const f = findItem(id);
    if (!f) return;
    const idx = f.v.items.indexOf(f.it);
    f.v.items.splice(idx, 1);
    save(); render();
    if ($('dlgPend').open) renderPend();
    let undone = false;
    const killT = setTimeout(() => { if (!undone) delPhotoData(f.it.photos); }, 6500);
    toast('Nota excluída', 'Desfazer', () => {
      undone = true;
      clearTimeout(killT);
      if (!S.vistorias.includes(f.v)) return;
      f.v.items.splice(Math.min(idx, f.v.items.length), 0, f.it);
      save(); render();
      if ($('dlgPend').open) renderPend();
    });
  }

  // ---------- menu de ações da nota ----------
  let moreTarget = null;
  function openMore(id) {
    const f = findItem(id);
    if (!f) return;
    moreTarget = id;
    const it = f.it, open = isOpen(it);
    $('moreTip').textContent = it.text.length > 90 ? it.text.slice(0, 90) + '…' : it.text;
    const rows = [
      ['dest', it.dest ? 'Mudar encaminhamento' : 'Encaminhar para a Manutenção ou outra área'],
      it.dest && ['prio', it.prio ? 'Prioridade: ' + PRIO_L[it.prio] : 'Definir prioridade'],
      open && ['fc', it.forecast ? 'Previsão: ' + C.fmtDate(it.forecast) : 'Previsão de resolução'],
      ['photo', 'Adicionar foto'],
      open && ['done', 'Marcar como resolvida'],
      it.dest && !open && ['reopen', 'Reabrir'],
      ['del', 'Excluir nota']
    ].filter(Boolean);
    $('moreList').innerHTML = rows.map(([k, l]) => `<button class="mrow${k === 'del' ? ' red' : ''}" data-m="${k}">${esc(l)}</button>`).join('');
    $('dlgMore').showModal();
  }
  $('moreClose').onclick = () => $('dlgMore').close();
  $('moreList').onclick = e => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    const id = moreTarget, k = b.dataset.m, f = findItem(id);
    $('dlgMore').close();
    if (!f) return;
    if (k === 'dest') openDest(id);
    else if (k === 'prio') openPrio(id);
    else if (k === 'fc') openFc(id);
    else if (k === 'photo') openPhoto(id);
    else if (k === 'del') deleteItem(id);
    else if (k === 'done' || k === 'reopen') {
      if (k === 'done') { f.it.status = 'done'; f.it.doneAt = Date.now(); toast('Marcada como resolvida'); }
      else { f.it.status = 'open'; delete f.it.doneAt; }
      save(); render();
    }
  };

  // ---------- histórico ----------
  function renderHist() {
    $('bkInfo').textContent = backupInfo();
    $('bkInfo').classList.toggle('due', backupDue());
    const list = S.vistorias.slice().sort((a, b) => b.created - a.created);
    $('histList').innerHTML = list.map(v => `
      <div class="hist${v.id === S.currentId ? ' cur' : ''}" data-id="${v.id}">
        <div class="hinfo"><b>${esc(v.title)}</b><small>${C.fmtDate(v.created)}, ${plural(v.items.length, 'nota', 'notas')}</small></div>
        <button class="mini" data-open>Abrir</button>
        <button class="mini red" data-rm>Excluir</button>
      </div>`).join('');
  }
  $('btnHist').onclick = () => { renderHist(); $('dlgHist').showModal(); };
  $('histClose').onclick = () => $('dlgHist').close();
  $('histList').onclick = e => {
    const row = e.target.closest('.hist');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.matches('[data-open]')) {
      S.currentId = id; save(); render(); $('dlgHist').close();
    } else if (e.target.matches('[data-rm]')) {
      const v = S.vistorias.find(x => x.id === id);
      const pend = v.items.filter(isOpen).length;
      const msg = 'Excluir "' + v.title + '"?' + (pend ? '\n\nAtenção: ' + plural(pend, 'pendência aberta some', 'pendências abertas somem') + ' junto.' : '');
      if (!confirm(msg)) return;
      delPhotoData(photosOf(v.items));
      S.vistorias = S.vistorias.filter(x => x.id !== id);
      if (!S.vistorias.length) S.vistorias.push(newVistoria());
      if (!S.vistorias.some(x => x.id === S.currentId)) S.currentId = S.vistorias[0].id;
      save(); render(); renderHist();
    }
  };
  $('btnNew').onclick = () => {
    if (recording) release();
    const v = newVistoria();
    S.vistorias.push(v);
    S.currentId = v.id;
    S.currentSector = 'Geral';
    S.currentDest = null;
    save(); render(); $('dlgHist').close();
  };

  // ---------- importar PDF ----------
  let imported = null; // resultado da leitura, aguardando a escolha do usuário

  function showImport(html, isErr) {
    $('impInfo').innerHTML = html;
    $('impInfo').classList.toggle('err', !!isErr);
    $('impNew').style.display = isErr ? 'none' : '';
    $('impMerge').style.display = isErr ? 'none' : '';
    $('dlgImport').showModal();
  }

  $('btnImport').onclick = () => $('fileImport').click();
  $('fileImport').onchange = async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    $('dlgHist').close();
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const r = C.parseVistoriaPdf(buf);
      r.items.forEach(i => { i.sector = C.resolveSector(i.sector, S.sectors, r.exact); });
      imported = r;
      const nSec = new Set(r.items.map(i => i.sector)).size;
      $('impMerge').textContent = 'Juntar em "' + cur().title + '"';
      showImport('<b>' + esc(r.title) + '</b>' + plural(r.items.length, 'nota', 'notas') + ' em ' + plural(nSec, 'setor', 'setores') + '.');
    } catch (err) {
      imported = null;
      showImport(esc(err.message || 'Não consegui ler esse PDF.'), true);
    }
  };
  $('impClose').onclick = () => { imported = null; $('dlgImport').close(); };

  function ensureSectors(items) {
    items.forEach(i => {
      if (!S.sectors.includes(i.sector)) S.sectors.push(i.sector);
      if (i.dest && !S.dests.includes(i.dest)) S.dests.push(i.dest);
    });
  }

  function mkItem(i) {
    const it = { id: uid(), sector: i.sector, text: i.text, ts: i.ts, nt: !!i.noTime };
    if (i.dest) {
      it.dest = i.dest;
      it.status = i.status === 'done' ? 'done' : 'open';
      if (i.doneAt) it.doneAt = i.doneAt;
      if (i.rechecks && i.rechecks.length) it.rechecks = i.rechecks;
      if (i.forecast) it.forecast = i.forecast;
      if (i.prio) it.prio = i.prio;
      if (i.fcPrev && i.fcPrev.length) it.fcPrev = i.fcPrev;
    }
    return it;
  }

  $('impNew').onclick = () => {
    if (!imported) return;
    ensureSectors(imported.items);
    const v = { id: uid(), title: imported.title, created: imported.created, items: imported.items.map(mkItem) };
    S.vistorias.push(v);
    S.currentId = v.id;
    S.currentSector = 'Geral';
    save(); render();
    toast(plural(v.items.length, 'nota importada', 'notas importadas'));
    imported = null;
    $('dlgImport').close();
  };

  $('impMerge').onclick = () => {
    if (!imported) return;
    const key = (sector, text) => C.norm(sector) + '|' + C.norm(text).replace(/\s+/g, ' ').trim();
    const v = cur();
    const have = new Set(v.items.map(i => key(i.sector, i.text)));
    let added = 0, dup = 0;
    ensureSectors(imported.items);
    imported.items.forEach(i => {
      const k = key(i.sector, i.text);
      if (have.has(k)) { dup++; return; }
      have.add(k);
      v.items.push(mkItem(i));
      added++;
    });
    save(); render();
    toast(plural(added, 'nota adicionada', 'notas adicionadas') + (dup ? ', ' + plural(dup, 'já existia', 'já existiam') : ''));
    imported = null;
    $('dlgImport').close();
  };

  // ---------- PDF ----------
  let pdfBlob = null, pdfName = '';

  let fileType = 'application/pdf';
  function showFile(blob, name, type, head) {
    pdfBlob = blob;
    pdfName = name;
    fileType = type;
    const canShare = navigator.canShare && navigator.canShare({ files: [new File([pdfBlob], pdfName, { type })] });
    $('pdfShare').style.display = canShare ? '' : 'none';
    $('pdfView').style.display = type === 'application/pdf' ? '' : 'none';
    $('pdfHead').textContent = head;
    const kb = pdfBlob.size / 1024;
    $('pdfInfo').textContent = pdfName + ', ' + (kb > 1024 ? (kb / 1024).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(kb)) + ' KB');
    $('dlgPdf').showModal();
  }
  function showPdf(doc, name) { showFile(doc.output('blob'), name, 'application/pdf', 'PDF pronto'); }
  function delivered() {
    if (fileType !== 'application/json') return;
    S.lastBackup = Date.now();
    save(); renderHeader();
    if ($('dlgHist').open) renderHist();
  }

  function mkName(prefix, base, ts) {
    return prefix + '_' + isoLocal(ts) + '_' + C.norm(base).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) + '.pdf';
  }

  // ---------- resumos que vão no topo dos PDFs ----------
  const RED = [200, 40, 31], ORANGE = [200, 120, 0];
  const W_COLS = [52, 21, 21, 21, 21, 21, 21];
  const hot = (n, c) => (n ? { v: n, c: c || RED, b: true } : 0);
  function avgTxt(a) {
    if (a < 1) return 'menos de 1 dia';
    const t = a.toFixed(1).replace('.', ',').replace(/,0$/, '');
    return t + (t === '1' ? ' dia' : ' dias');
  }
  function resolutionNotes(dests) {
    const out = [];
    dests.forEach(d => {
      const st = C.resolutionStats(allTracked().map(x => x.it).filter(i => i.dest === d));
      if (!st.n) return;
      out.push(`${d}: tempo médio de resolução de ${avgTxt(st.avg)} (${plural(st.n, 'resolvida', 'resolvidas')} no histórico)` +
        (st.withFc ? `, ${st.onTime} de ${st.withFc} dentro da previsão.` : '.'));
    });
    return out;
  }

  function directorSummary(v) {
    if (!v.items.length) return null;
    const rows = [], tot = [0, 0, 0, 0, 0, 0];
    C.groupItems(v.items, S.sectors).forEach(g => {
      const its = g.items;
      const c = [
        its.length,
        its.filter(i => i.dest).length,
        its.filter(isOpen).length,
        its.filter(i => { const f = fcState(i); return f && f.late; }).length,
        its.filter(i => isOpen(i) && i.prio === 'alta').length,
        its.filter(i => i.dest && i.status === 'done').length
      ];
      c.forEach((n, k) => { tot[k] += n; });
      rows.push([g.name, c[0], c[1], c[2], hot(c[3]), hot(c[4]), c[5]]);
    });
    const notes = [];
    const old = allTracked().filter(x => x.v.id !== v.id && isOpen(x.it));
    if (old.length) {
      const ol = old.filter(x => { const f = fcState(x.it); return f && f.late; }).length;
      notes.push({ text: `Pendências de visitas anteriores ainda abertas: ${old.length}` + (ol ? ` (${plural(ol, 'atrasada', 'atrasadas')}).` : '.'), c: ol ? RED : null, b: !!ol });
    }
    resolutionNotes(S.dests.filter(d => allTracked().some(x => x.it.dest === d))).forEach(t => notes.push(t));
    return {
      title: 'Resumo da vistoria', widths: W_COLS,
      head: ['Setor', 'Notas', 'Encaminhadas', 'Abertas', 'Atrasadas', 'Prior. alta', 'Resolvidas'],
      rows, total: rows.length > 1 ? ['Total', ...tot] : null, notes
    };
  }

  function maintSummary(items, dest) {
    const rows = [], tot = [0, 0, 0, 0, 0, 0];
    C.groupItems(items, S.sectors).forEach(g => {
      const op = g.items.filter(isOpen);
      const c = [
        g.items.length,
        op.filter(i => { const f = fcState(i); return f && f.late; }).length,
        op.filter(i => i.prio === 'alta').length,
        op.filter(i => i.prio === 'media').length,
        op.filter(i => i.prio === 'baixa').length,
        op.filter(i => !i.forecast).length
      ];
      c.forEach((n, k) => { tot[k] += n; });
      rows.push([g.name, c[0], hot(c[1]), hot(c[2]), hot(c[3], ORANGE), c[4], c[5]]);
    });
    return {
      title: 'Resumo', widths: W_COLS,
      head: ['Setor', 'Itens', 'Atrasadas', 'Alta', 'Média', 'Baixa', 'Sem previsão'],
      rows, total: rows.length > 1 ? ['Total', ...tot] : null,
      notes: resolutionNotes(dest ? [dest] : S.dests)
    };
  }

  async function fullPdf() {
    const v = cur();
    if (!(await preparePdf(v.items))) return;
    const doc = C.buildPdf(window.jspdf.jsPDF, v, S.sectors, {
      summary: directorSummary(v),
      photo: pdfPhoto,
      meta: i => C.vistoriaMeta(i, Date.now())
    });
    showPdf(doc, mkName('Vistoria', v.title, v.created));
  }

  async function sectorPdf(sector, withOld) {
    const v = cur(), now = Date.now();
    const own = v.items.filter(i => i.sector === sector);
    const old = withOld ? allTracked().filter(x => x.v.id !== v.id && isOpen(x.it) && x.it.sector === sector).map(x => x.it) : [];
    const items = own.concat(old).map(i => Object.assign({}, i, { sector }));
    if (!items.length) { toast('Esse setor não tem notas'); return; }
    items.sort((a, b) => (PRANK[a.prio] ?? 3) - (PRANK[b.prio] ?? 3) || a.ts - b.ts);
    if (!(await preparePdf(items))) return;
    const fake = { title: v.title, created: v.created, items };
    const doc = C.buildPdf(window.jspdf.jsPDF, fake, S.sectors, {
      heading: 'Relatório do setor ' + sector, embed: false,
      subtitle: (v.title.includes(C.fmtDate(v.created)) ? v.title : v.title + '  •  ' + C.fmtDate(v.created)) + '  •  ' + plural(items.length, 'apontamento', 'apontamentos') +
        (old.length ? ' (' + plural(old.length, 'de visita anterior', 'de visitas anteriores') + ')' : ''),
      photo: pdfPhoto,
      signature: 'Ciente do encarregado do setor ' + sector,
      meta: i => C.vistoriaMeta(i, now)
    });
    showPdf(doc, mkName('Setor-' + C.norm(sector).replace(/[^a-z0-9]+/g, '-'), v.title, v.created));
  }

  $('btnPdf').onclick = () => {
    const v = cur();
    needPdf().catch(() => {});
    const own = {};
    v.items.forEach(i => { own[i.sector] = (own[i.sector] || 0) + 1; });
    const oldSec = new Set(allTracked().filter(x => x.v.id !== v.id && isOpen(x.it)).map(x => x.it.sector));
    const secs = S.sectors.filter(x => own[x] || oldSec.has(x));
    if (!secs.length) { toast('Nenhuma nota para o PDF'); return; }
    $('repAll').textContent = 'Vistoria completa' + (v.items.length ? ' (' + plural(v.items.length, 'nota', 'notas') + ')' : '');
    $('repAll').style.display = v.items.length ? '' : 'none';
    $('repGrid').innerHTML = secs.map(x => `
      <button class="tile" data-s="${esc(x)}"><i style="background:${colorFor(x)}"></i><b>${esc(x)}</b>${own[x] ? `<small>${own[x]}</small>` : '<small>antigas</small>'}</button>`).join('');
    $('dlgRep').showModal();
  };
  $('repClose').onclick = () => $('dlgRep').close();
  $('repAll').onclick = () => {
    if (!cur().items.length) return;
    $('dlgRep').close(); fullPdf();
  };
  $('repGrid').onclick = e => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    $('dlgRep').close(); sectorPdf(b.dataset.s, $('repOld').checked);
  };

  $('pdfClose').onclick = () => $('dlgPdf').close();
  $('pdfSave').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(pdfBlob);
    a.download = pdfName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    delivered();
  };
  $('pdfView').onclick = () => { window.open(URL.createObjectURL(pdfBlob), '_blank'); };
  $('pdfShare').onclick = async () => {
    try {
      await navigator.share({ files: [new File([pdfBlob], pdfName, { type: fileType })], title: fileType === 'application/pdf' ? cur().title : 'Backup da vistoria' });
      delivered();
    } catch (e) { /* cancelado */ }
  };

  // ---------- backup ----------
  const BK_DAYS = 7;
  function backupDue() {
    if (!S.vistorias.some(v => v.items.length)) return false;
    return !S.lastBackup || Date.now() - S.lastBackup > BK_DAYS * DAY;
  }
  function backupInfo() {
    if (!S.lastBackup) return 'Você ainda não fez backup. Tudo fica só neste celular: se limpar os dados do navegador ou trocar de aparelho, perde as notas e fotos.';
    const d = Math.floor((Date.now() - S.lastBackup) / DAY);
    return 'Último backup ' + (d === 0 ? 'hoje' : d === 1 ? 'ontem' : 'há ' + d + ' dias') + ' (' + C.fmtDate(S.lastBackup) + ').' +
      (backupDue() ? ' Faça um novo para não perder nada.' : '');
  }
  $('btnBackup').onclick = async () => {
    toast('Preparando backup…');
    const photos = {};
    try {
      for (const n of STORES) photos[n] = (await dbRun([n], 'readonly', t => t.objectStore(n).getAll())) || [];
    } catch (e) { toast('Não consegui ler as fotos para o backup'); return; }
    const now = Date.now();
    const data = JSON.stringify({ app: 'vistoria-por-voz', version: 2, exported: now, state: Object.assign({}, S, { lastBackup: now }), photos });
    $('dlgHist').close();
    showFile(new Blob([data], { type: 'application/json' }), 'Backup_Vistoria_' + isoLocal(now) + '.json', 'application/json', 'Backup pronto');
    $('pdfInfo').textContent += '. Guarde no Drive ou mande para você no WhatsApp.';
  };
  $('btnRestore').onclick = () => $('fileRestore').click();
  $('fileRestore').onchange = async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    let d;
    try { d = JSON.parse(await f.text()); } catch (err) { toast('Esse arquivo não é um backup do app'); return; }
    if (!d || d.app !== 'vistoria-por-voz' || !d.state || !Array.isArray(d.state.vistorias)) { toast('Esse arquivo não é um backup do app'); return; }
    const nV = d.state.vistorias.length, nN = d.state.vistorias.reduce((a, v) => a + (v.items || []).length, 0);
    const nP = (d.photos && d.photos.thumb || []).length;
    if (!confirm('Restaurar o backup de ' + C.fmtDate(d.exported || Date.now()) + '?\n\n' + plural(nV, 'vistoria', 'vistorias') + ', ' + plural(nN, 'nota', 'notas') + ', ' + plural(nP, 'foto', 'fotos') +
      '.\n\nIsso SUBSTITUI tudo o que está no app agora.')) return;
    try {
      await dbRun(STORES, 'readwrite', t => {
        STORES.forEach(n => {
          const st = t.objectStore(n);
          st.clear();
          ((d.photos && d.photos[n]) || []).forEach(r => { if (r && r.id && r.d) st.put(r); });
        });
      });
    } catch (err) { toast('Não consegui restaurar as fotos'); return; }
    const st = d.state;
    if (!Array.isArray(st.dests) || !st.dests.length) st.dests = ['Manutenção'];
    if (!Array.isArray(st.sectors) || !st.sectors.length) st.sectors = C.DEFAULT_SECTORS.slice();
    if (!st.vistorias.length) { const v = newVistoria(); st.vistorias.push(v); st.currentId = v.id; }
    if (!st.vistorias.some(v => v.id === st.currentId)) st.currentId = st.vistorias[0].id;
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (err) { toast('Sem espaço para restaurar'); return; }
    location.reload();
  };

  // ---------- fotos: escolher origem e ver ----------
  let photoTarget = null, viewing = null;

  function openPhoto(id) {
    const f = findItem(id);
    if (!f) return;
    photoTarget = id;
    const t = f.it.text.length > 70 ? f.it.text.slice(0, 70) + '…' : f.it.text;
    $('photoTip').textContent = 'Nota: ' + t;
    $('dlgPhoto').showModal();
  }
  $('cam').onclick = () => {
    const items = cur().items;
    if (!items.length) { toast('Crie uma nota primeiro e depois anexe a foto'); return; }
    openPhoto(items.reduce((a, b) => (b.ts >= a.ts ? b : a)).id);
  };
  $('photoClose').onclick = () => $('dlgPhoto').close();
  $('photoCam').onclick = () => $('fileCam').click();
  $('photoGal').onclick = () => $('fileGal').click();
  function gotFiles(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    $('dlgPhoto').close();
    addPhotos(files, photoTarget);
  }
  $('fileCam').onchange = gotFiles;
  $('fileGal').onchange = gotFiles;

  async function viewPhoto(pid, itemId) {
    viewing = { pid, itemId };
    const t = TH.get(pid);
    $('viewImg').src = t ? t.d : '';
    $('dlgView').showModal();
    try {
      const r = await dbRun(['full'], 'readonly', tx => tx.objectStore('full').get(pid));
      if (r && viewing && viewing.pid === pid) $('viewImg').src = r.d;
    } catch (e) { /* fica a miniatura */ }
  }
  $('viewClose').onclick = () => { $('dlgView').close(); viewing = null; $('viewImg').removeAttribute('src'); };
  $('viewDel').onclick = () => {
    if (!viewing) return;
    if (!confirm('Excluir esta foto?')) return;
    const f = findItem(viewing.itemId);
    if (f) f.it.photos = (f.it.photos || []).filter(x => x !== viewing.pid);
    delPhotoData([viewing.pid]);
    save(); render();
    if ($('dlgPend').open) renderPend();
    $('dlgView').close(); viewing = null;
  };

  // ---------- previsão de resolução ----------
  let fcTarget = null;
  const addDays = n => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d.getTime(); };

  function openFc(id) {
    const f = findItem(id);
    if (!f) return;
    fcTarget = id;
    const t = f.it.text.length > 70 ? f.it.text.slice(0, 70) + '…' : f.it.text;
    $('fcTip').textContent = (f.it.forecast ? 'Previsão atual: ' + C.fmtDate(f.it.forecast) + '. ' : 'Quando a Manutenção responder, marque o prazo. ') + t;
    $('fcGrid').innerHTML = [[3, '3 dias'], [5, '5 dias'], [7, '1 semana']].map(([n, l]) =>
      `<button class="tile" data-n="${n}"><b>${l}</b><small>${shortDate(addDays(n))}</small></button>`).join('');
    $('fcDate').min = isoLocal(Date.now());
    $('fcDate').value = f.it.forecast ? isoLocal(f.it.forecast) : '';
    $('fcClear').style.display = f.it.forecast ? '' : 'none';
    $('dlgFc').showModal();
  }
  function setForecast(ts) {
    const f = findItem(fcTarget);
    if (!f) return;
    const prev = f.it.forecast;
    if (ts == null) delete f.it.forecast;
    else {
      if (prev && prev !== ts) f.it.fcPrev = (f.it.fcPrev || []).concat(prev);
      f.it.forecast = ts;
    }
    save(); render();
    if ($('dlgPend').open) renderPend();
    $('dlgFc').close();
    toast(ts == null ? 'Previsão removida' : 'Previsto para ' + C.fmtDate(ts));
  }
  $('fcClose').onclick = () => $('dlgFc').close();
  $('fcGrid').onclick = e => { const b = e.target.closest('[data-n]'); if (b) setForecast(addDays(+b.dataset.n)); };
  $('fcSet').onclick = () => {
    const m = $('fcDate').value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) { toast('Escolha uma data'); return; }
    const ts = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    if (ts < addDays(0)) { toast('A data não pode ser anterior a hoje'); return; }
    setForecast(ts);
  };
  $('fcClear').onclick = () => setForecast(null);

  // ---------- prioridade ----------
  let prioTarget = null;
  function openPrio(id) {
    const f = findItem(id);
    if (!f) return;
    prioTarget = id;
    const t = f.it.text.length > 70 ? f.it.text.slice(0, 70) + '…' : f.it.text;
    $('prioTip').textContent = t;
    $('prioGrid').innerHTML = ['alta', 'media', 'baixa'].map(k =>
      `<button class="tile ${k}${f.it.prio === k ? ' on' : ''}" data-p="${k}"><i></i><b>${PRIO_L[k]}</b></button>`).join('') +
      `<button class="tile${!f.it.prio ? ' on' : ''}" data-p=""><i style="background:#9aa6b8"></i><b>Sem prioridade</b></button>`;
    $('dlgPrio').showModal();
  }
  $('prioClose').onclick = () => $('dlgPrio').close();
  $('prioGrid').onclick = e => {
    const b = e.target.closest('[data-p]');
    const f = b && findItem(prioTarget);
    if (!f) return;
    if (b.dataset.p) f.it.prio = b.dataset.p; else delete f.it.prio;
    save(); render();
    if ($('dlgPend').open) renderPend();
    $('dlgPrio').close();
  };

  // ---------- início ----------
  if (!SR) $('unsupported').style.display = 'block';
  render();
  loadThumbs();
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* ok */ }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
