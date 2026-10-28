(function () {
  'use strict';
  const C = window.VistoriaCore;
  const KEY = 'vistoria.v1';
  const DAY = 86400000;
  const $ = id => document.getElementById(id);

  const ICON_MIC = '<svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM18 12a6 6 0 0 1-12 0M12 18v3"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/></svg>';
  const ICON_CAM = '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/></svg>';
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


  // ---------- fotos (IndexedDB: miniatura + versão reduzida) ----------
  const TH = new Map();   // id -> { d (dataURL), w, h }  miniaturas em memória
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('vistoria-fotos', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('thumb', { keyPath: 'id' }); r.result.createObjectStore('full', { keyPath: 'id' }); };
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
  function putPhoto(id, thumb, full) {
    return dbRun(['thumb', 'full'], 'readwrite', t => {
      t.objectStore('thumb').put({ id, d: thumb.d, w: thumb.w, h: thumb.h });
      t.objectStore('full').put({ id, d: full.d });
    });
  }
  function delPhotoData(ids) {
    ids = (ids || []).filter(Boolean);
    ids.forEach(id => TH.delete(id));
    if (!ids.length) return;
    dbRun(['thumb', 'full'], 'readwrite', t => ids.forEach(id => { t.objectStore('thumb').delete(id); t.objectStore('full').delete(id); })).catch(() => {});
  }
  const photosOf = items => [].concat(...items.map(i => i.photos || []));

  let photosLoaded = false;
  function loadThumbs() {
    return dbRun(['thumb'], 'readonly', t => t.objectStore('thumb').getAll()).then(rows => {
      (rows || []).forEach(r => TH.set(r.id, { d: r.d, w: r.w, h: r.h }));
      photosLoaded = true;
      // limpa fotos órfãs (de notas que não existem mais)
      const used = new Set(photosOf([].concat(...S.vistorias.map(v => v.items))));
      const orphans = (rows || []).map(r => r.id).filter(id => !used.has(id));
      if (orphans.length) delPhotoData(orphans);
      render();
      if ($('dlgPend').open) renderPend();
    }).catch(() => {});
  }

  function loadImg(file) {
    return new Promise((res, rej) => {
      const u = URL.createObjectURL(file), im = new Image();
      im.onload = () => { URL.revokeObjectURL(u); res(im); };
      im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('img')); };
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
        const thumb = shrink(im, 600, 0.75), full = shrink(im, 1280, 0.7);
        const id = uid();
        await putPhoto(id, thumb, full);
        TH.set(id, thumb);
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
      ? `<button class="pic" data-pic="${id}" aria-label="Ver foto"><img src="${TH.get(id).d}" alt="Foto da nota"></button>`
      : '<span class="pic"></span>').join('') + '</div>';
  }
  const pdfPhoto = id => { const t = TH.get(id); return t ? { data: t.d, w: t.w, h: t.h } : null; };

  // ---------- previsão ----------
  function shortDate(ts) { const d = new Date(ts), p = x => String(x).padStart(2, '0'); return p(d.getDate()) + '/' + p(d.getMonth() + 1); }
  const PRIO_L = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };
  function fcState(it) { return C.forecastState(it, Date.now()); }
  const lateCount = () => allTracked().filter(x => { const f = fcState(x.it); return f && f.late; }).length;
  function dia(n) { return n + (n === 1 ? ' dia' : ' dias'); }

  // ---------- UI ----------
  let toastT;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 2300);
  }

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

    $('destVal').textContent = S.currentDest || 'Nenhum';
    $('destBar').classList.toggle('on', !!S.currentDest);

    const other = openInOtherVisits(S.currentSector);
    $('banner').style.display = other ? '' : 'none';
    $('bannerTxt').textContent = `${S.currentSector}: ${plural(other, 'pendência aberta', 'pendências abertas')} de visitas anteriores`;

    const oc = openCount();
    $('badge').textContent = oc > 99 ? '99+' : oc;
    $('badge').style.display = oc ? '' : 'none';
  }

  function destTag(i) {
    if (!i.dest) return '<button class="tag none" data-dest>Encaminhar</button>';
    const done = i.status === 'done';
    const d = C.openDays(i.ts, Date.now());
    let h = `<button class="tag" data-dest aria-label="Mudar encaminhamento">${ICON_ARROW}${esc(i.dest)}</button>` +
      `<span class="st ${done ? 'done' : 'open'}">${done ? 'Resolvida' : d === 0 ? 'Aberta hoje' : 'Aberta há ' + dia(d)}</span>`;
    h += `<button class="pr ${i.prio || 'none'}" data-pr>${i.prio ? PRIO_L[i.prio] : 'Prioridade'}</button>`;
    if (!done) {
      const f = fcState(i);
      h += !f ? '<button class="fc none" data-fc>Previsão</button>'
        : f.late ? `<button class="fc late" data-fc>Atrasada ${dia(f.days)}</button>`
        : `<button class="fc" data-fc>Previsto ${f.left === 0 ? 'para hoje' : shortDate(i.forecast)}</button>`;
    }
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
        ${g.items.map(i => `
          <div class="note${(() => { const f = fcState(i); return f && f.late ? ' late' : ''; })()}" data-id="${i.id}" style="--c:${colorFor(i.sector)}">
            <div class="ntxt" contenteditable="true" spellcheck="false">${esc(i.text)}</div>
            ${picsHtml(i)}
            <div class="nmeta">
              <div class="nleft">
                <label class="pillwrap"><span class="d"></span><select data-move aria-label="Mudar de setor">${opts(i.sector)}</select></label>
                ${destTag(i)}
                <button class="tag photo" data-photo aria-label="Adicionar foto">${ICON_CAM}Foto</button>
              </div>
              <div class="nend">
                <span class="time">${i.nt ? '' : C.fmtTime(i.ts)}</span>
                <button class="del" data-del aria-label="Excluir nota">${ICON_TRASH}</button>
              </div>
            </div>
          </div>`).join('')}
      </section>`).join('');
  }

  function render() { renderHeader(); renderList(); }

  // ---------- notas ----------
  function addItem(text, sector) {
    const it = { id: uid(), sector: sector || S.currentSector, text, ts: Date.now() };
    if (S.currentDest) { it.dest = S.currentDest; it.status = 'open'; }
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
    r.items.forEach(t => addItem(t));
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
  }

  function openDest(target) {
    destTarget = target;
    $('destTitle').textContent = target ? 'Encaminhar esta nota' : 'Encaminhar para';
    $('destTip').textContent = target ? '' :
      'As próximas notas já saem encaminhadas e ficam em aberto até você conferir. Volte para "Nenhum" quando terminar.';
    renderDestGrid();
    $('dlgDest').showModal();
  }

  function applyDest(name) {
    if (!destTarget) { S.currentDest = name; return; }
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
    if (!$('dlgPend').open) { /* nada */ } else renderPend();
    $('dlgDest').close();
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

  $('pendPdf').onclick = () => {
    const rows = pendRows();
    if (!rows.length) { toast('Nada para colocar no relatório'); return; }
    if (!window.jspdf) { toast('A biblioteca de PDF não carregou'); return; }
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
    if (!txt) { delPhotoData(it.photos); cur().items = cur().items.filter(i => i.id !== id); save(); render(); return; }
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
    const b = e.target.closest('[data-del]');
    if (!b) return;
    const id = b.closest('.note').dataset.id;
    const gone = cur().items.find(i => i.id === id);
    if (gone) delPhotoData(gone.photos);
    cur().items = cur().items.filter(i => i.id !== id);
    save(); render();
  });

  // ---------- histórico ----------
  function renderHist() {
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

  function showPdf(doc, name) {
    pdfBlob = doc.output('blob');
    pdfName = name;
    const canShare = navigator.canShare && navigator.canShare({ files: [new File([pdfBlob], pdfName, { type: 'application/pdf' })] });
    $('pdfShare').style.display = canShare ? '' : 'none';
    $('pdfInfo').textContent = pdfName + ', ' + Math.max(1, Math.round(pdfBlob.size / 1024)) + ' KB';
    $('dlgPdf').showModal();
  }

  function mkName(prefix, base, ts) {
    return prefix + '_' + isoLocal(ts) + '_' + C.norm(base).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) + '.pdf';
  }

  function fullPdf() {
    const v = cur();
    const doc = C.buildPdf(window.jspdf.jsPDF, v, S.sectors, {
      photo: pdfPhoto,
      meta: i => C.vistoriaMeta(i, Date.now())
    });
    showPdf(doc, mkName('Vistoria', v.title, v.created));
  }

  function sectorPdf(sector, withOld) {
    const v = cur(), now = Date.now();
    const own = v.items.filter(i => i.sector === sector);
    const old = withOld ? allTracked().filter(x => x.v.id !== v.id && isOpen(x.it) && x.it.sector === sector).map(x => x.it) : [];
    const items = own.concat(old).map(i => Object.assign({}, i, { sector }));
    if (!items.length) { toast('Esse setor não tem notas'); return; }
    items.sort((a, b) => (PRANK[a.prio] ?? 3) - (PRANK[b.prio] ?? 3) || a.ts - b.ts);
    const fake = { title: v.title, created: v.created, items };
    const doc = C.buildPdf(window.jspdf.jsPDF, fake, S.sectors, {
      heading: 'Relatório do setor ' + sector, embed: false,
      subtitle: (v.title.includes(C.fmtDate(v.created)) ? v.title : v.title + '  •  ' + C.fmtDate(v.created)) + '  •  ' + plural(items.length, 'apontamento', 'apontamentos') +
        (old.length ? ' (' + plural(old.length, 'de visita anterior', 'de visitas anteriores') + ')' : ''),
      photo: pdfPhoto,
      meta: i => C.vistoriaMeta(i, now)
    });
    showPdf(doc, mkName('Setor-' + C.norm(sector).replace(/[^a-z0-9]+/g, '-'), v.title, v.created));
  }

  $('btnPdf').onclick = () => {
    const v = cur();
    if (!window.jspdf) { toast('A biblioteca de PDF não carregou'); return; }
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
  };
  $('pdfView').onclick = () => { window.open(URL.createObjectURL(pdfBlob), '_blank'); };
  $('pdfShare').onclick = async () => {
    try {
      await navigator.share({ files: [new File([pdfBlob], pdfName, { type: 'application/pdf' })], title: cur().title });
    } catch (e) { /* cancelado */ }
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
