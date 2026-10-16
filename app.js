(function () {
  'use strict';
  const C = window.VistoriaCore;
  const KEY = 'vistoria.v1';
  const $ = id => document.getElementById(id);

  // ---------- estado ----------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function newVistoria() {
    const now = Date.now();
    return { id: uid(), title: 'Vistoria ' + C.fmtDate(now), created: now, items: [] };
  }

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && d.vistorias && d.vistorias.length) return d;
    } catch (e) { /* ignora */ }
    const v = newVistoria();
    return { sectors: C.DEFAULT_SECTORS.slice(), vistorias: [v], currentId: v.id, currentSector: 'Geral' };
  }

  let S = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Sem espaço para salvar'); }
  }
  function cur() { return S.vistorias.find(v => v.id === S.currentId) || S.vistorias[0]; }

  // ---------- UI ----------
  let toastT;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderChips() {
    const el = $('chips');
    el.innerHTML = S.sectors.map(s =>
      `<button class="chip${s === S.currentSector ? ' on' : ''}" data-s="${esc(s)}">${esc(s)}</button>`
    ).join('') + '<button class="chip add" data-add="1">+ Setor</button>';
    $('hint').innerHTML = `Setor atual: <b>${esc(S.currentSector)}</b> — ou diga <b>"setor acabamento"</b> e continue falando.`;
  }

  function renderList() {
    const v = cur();
    $('title').value = v.title;
    const groups = C.groupItems(v.items, S.sectors);
    if (!groups.length) {
      $('list').innerHTML = '<div class="empty"><big>🎤</big>Toque no microfone e fale.<br>Cada pausa vira uma nota no setor atual.</div>';
      return;
    }
    const opts = sel => S.sectors.concat(S.sectors.includes(sel) ? [] : [sel])
      .map(s => `<option${s === sel ? ' selected' : ''}>${esc(s)}</option>`).join('');
    $('list').innerHTML = groups.map(g => `
      <div class="group">
        <div class="ghead">${esc(g.name)} <span>${g.items.length}</span></div>
        ${g.items.map(i => `
          <div class="note" data-id="${i.id}">
            <div class="ntxt" contenteditable="true" spellcheck="false">${esc(i.text)}</div>
            <div class="nside">
              <select data-move>${opts(i.sector)}</select>
              <span class="time">${C.fmtTime(i.ts)}</span>
              <button class="del" data-del>Excluir</button>
            </div>
          </div>`).join('')}
      </div>`).join('');
  }

  function render() { renderChips(); renderList(); }

  // ---------- notas ----------
  function addItem(text, sector) {
    const v = cur();
    v.items.push({ id: uid(), sector: sector || S.currentSector, text, ts: Date.now() });
    save();
  }

  function setSector(name) {
    if (!S.sectors.includes(name)) S.sectors.push(name);
    S.currentSector = name;
  }

  let lastSeg = '', lastSegAt = 0;
  function handleSpeech(raw) {
    const now = Date.now();
    const key = C.norm(raw).trim();
    if (key && key === lastSeg && now - lastSegAt < 3000) return; // evita duplicata do Android
    lastSeg = key; lastSegAt = now;

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

  // ---------- reconhecimento de voz ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, recording = false, wake = null;

  function setRec(on) {
    recording = on;
    $('mic').classList.toggle('rec', on);
    $('mic').textContent = on ? '⏹' : '🎤';
    if (!on) $('live').textContent = '';
  }

  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator) wake = await navigator.wakeLock.request('screen');
      else if (wake) { await wake.release(); wake = null; }
    } catch (e) { /* ok */ }
  }

  function startRec() {
    if (!SR) { toast('Sem reconhecimento de voz neste navegador'); return; }
    rec = new SR();
    rec.lang = 'pt-BR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) handleSpeech(r[0].transcript);
        else interim += r[0].transcript;
      }
      $('live').textContent = interim ? '… ' + interim : '';
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setRec(false); keepAwake(false);
        toast('Permita o microfone nas configurações do site');
      } else if (e.error === 'network') {
        toast('Sem internet: a transcrição precisa de conexão');
      }
    };
    rec.onend = () => {
      if (recording) { try { rec.start(); } catch (err) { /* já iniciando */ } }
    };

    try {
      rec.start();
      setRec(true);
      keepAwake(true);
    } catch (err) { toast('Não consegui iniciar o microfone'); }
  }

  function stopRec() {
    setRec(false);
    keepAwake(false);
    try { rec && rec.stop(); } catch (e) { /* ok */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && recording) keepAwake(true);
  });

  // ---------- eventos ----------
  $('mic').onclick = () => (recording ? stopRec() : startRec());

  $('chips').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.add) {
      const name = (prompt('Nome do novo setor:') || '').trim();
      if (name) { setSector(C.titleCase(name)); save(); render(); }
      return;
    }
    S.currentSector = b.dataset.s;
    save(); render();
  };

  function typed() {
    const t = $('txt').value.trim();
    if (!t) return;
    $('txt').value = '';
    handleSpeech(t);
  }
  $('send').onclick = typed;
  $('txt').addEventListener('keydown', e => { if (e.key === 'Enter') typed(); });

  $('title').addEventListener('input', () => { cur().title = $('title').value.trim() || 'Vistoria'; save(); });

  $('list').addEventListener('focusout', e => {
    const t = e.target.closest('.ntxt');
    if (!t) return;
    const id = t.closest('.note').dataset.id;
    const it = cur().items.find(i => i.id === id);
    const txt = t.textContent.trim();
    if (!it) return;
    if (!txt) { cur().items = cur().items.filter(i => i.id !== id); save(); render(); return; }
    if (txt !== it.text) { it.text = txt; save(); }
  });
  $('list').addEventListener('change', e => {
    if (!e.target.matches('[data-move]')) return;
    const id = e.target.closest('.note').dataset.id;
    const it = cur().items.find(i => i.id === id);
    if (it) { it.sector = e.target.value; save(); render(); }
  });
  $('list').addEventListener('click', e => {
    if (!e.target.matches('[data-del]')) return;
    const id = e.target.closest('.note').dataset.id;
    cur().items = cur().items.filter(i => i.id !== id);
    save(); render();
  });

  // ---------- histórico ----------
  function renderHist() {
    const list = S.vistorias.slice().sort((a, b) => b.created - a.created);
    $('histList').innerHTML = list.map(v => `
      <div class="hist${v.id === S.currentId ? ' cur' : ''}" data-id="${v.id}">
        <div class="hinfo"><b>${esc(v.title)}</b><small>${C.fmtDate(v.created)} · ${v.items.length} notas</small></div>
        <button class="mini" data-open>Abrir</button>
        <button class="mini red" data-rm>🗑</button>
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
      if (!confirm('Excluir "' + v.title + '"?')) return;
      S.vistorias = S.vistorias.filter(x => x.id !== id);
      if (!S.vistorias.length) S.vistorias.push(newVistoria());
      if (!S.vistorias.some(x => x.id === S.currentId)) S.currentId = S.vistorias[0].id;
      save(); render(); renderHist();
    }
  };
  $('btnNew').onclick = () => {
    if (recording) stopRec();
    const v = newVistoria();
    S.vistorias.push(v);
    S.currentId = v.id;
    S.currentSector = 'Geral';
    save(); render(); $('dlgHist').close();
  };

  // ---------- PDF ----------
  let pdfBlob = null, pdfName = '';
  $('btnPdf').onclick = () => {
    const v = cur();
    if (!v.items.length) { toast('Nenhuma nota para o PDF'); return; }
    if (recording) stopRec();
    if (!window.jspdf) { toast('Biblioteca de PDF não carregou'); return; }
    const doc = C.buildPdf(window.jspdf.jsPDF, v, S.sectors);
    pdfBlob = doc.output('blob');
    pdfName = 'Vistoria_' + new Date(v.created).toISOString().slice(0, 10) + '_' + C.norm(v.title).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) + '.pdf';
    const canShare = navigator.canShare && navigator.canShare({ files: [new File([pdfBlob], pdfName, { type: 'application/pdf' })] });
    $('pdfShare').style.display = canShare ? '' : 'none';
    $('pdfInfo').textContent = pdfName + ' · ' + Math.max(1, Math.round(pdfBlob.size / 1024)) + ' KB';
    $('dlgPdf').showModal();
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

  // ---------- start ----------
  if (!SR) $('unsupported').style.display = 'block';
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
