(function () {
  'use strict';
  const C = window.VistoriaCore;
  const KEY = 'vistoria.v1';
  const $ = id => document.getElementById(id);

  const ICON_MIC = '<svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM18 12a6 6 0 0 1-12 0M12 18v3"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/></svg>';

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

  // cor de cada setor (cor de carretel de linha), estável pela posição na lista
  const PALETTE = ['#2f6fde', '#e4572e', '#12a594', '#e09f00', '#8e5bd6', '#d6336c', '#3e9b2f', '#b8643c', '#0e9ec4', '#7a8f1e', '#c026d3', '#0f5d8c'];
  function colorFor(name) {
    if (name === 'Geral') return '#6b7a90';
    const i = S.sectors.indexOf(name);
    return PALETTE[(i < 0 ? name.length : i) % PALETTE.length];
  }

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
    $('stats').textContent = n
      ? `${n} ${n === 1 ? 'nota' : 'notas'} em ${g} ${g === 1 ? 'setor' : 'setores'}`
      : 'Nenhuma nota ainda';
    $('sectorName').textContent = S.currentSector;
    $('sectorDot').style.background = colorFor(S.currentSector);
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
          <div class="note" data-id="${i.id}" style="--c:${colorFor(i.sector)}">
            <div class="ntxt" contenteditable="true" spellcheck="false">${esc(i.text)}</div>
            <div class="nmeta">
              <label class="pillwrap"><span class="d"></span><select data-move aria-label="Mudar de setor">${opts(i.sector)}</select></label>
              <span class="time">${C.fmtTime(i.ts)}</span>
              <button class="del" data-del aria-label="Excluir nota">${ICON_TRASH}</button>
            </div>
          </div>`).join('')}
      </section>`).join('');
  }

  function render() { renderHeader(); renderList(); }

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
    const b = e.target.closest('[data-del]');
    if (!b) return;
    const id = b.closest('.note').dataset.id;
    cur().items = cur().items.filter(i => i.id !== id);
    save(); render();
  });

  // ---------- histórico ----------
  function renderHist() {
    const list = S.vistorias.slice().sort((a, b) => b.created - a.created);
    $('histList').innerHTML = list.map(v => `
      <div class="hist${v.id === S.currentId ? ' cur' : ''}" data-id="${v.id}">
        <div class="hinfo"><b>${esc(v.title)}</b><small>${C.fmtDate(v.created)}, ${v.items.length} ${v.items.length === 1 ? 'nota' : 'notas'}</small></div>
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
      if (!confirm('Excluir "' + v.title + '"?')) return;
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
    save(); render(); $('dlgHist').close();
  };

  // ---------- PDF ----------
  let pdfBlob = null, pdfName = '';
  $('btnPdf').onclick = () => {
    const v = cur();
    if (!v.items.length) { toast('Nenhuma nota para o PDF'); return; }
    if (!window.jspdf) { toast('A biblioteca de PDF não carregou'); return; }
    const doc = C.buildPdf(window.jspdf.jsPDF, v, S.sectors);
    pdfBlob = doc.output('blob');
    pdfName = 'Vistoria_' + new Date(v.created).toISOString().slice(0, 10) + '_' + C.norm(v.title).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) + '.pdf';
    const canShare = navigator.canShare && navigator.canShare({ files: [new File([pdfBlob], pdfName, { type: 'application/pdf' })] });
    $('pdfShare').style.display = canShare ? '' : 'none';
    $('pdfInfo').textContent = pdfName + ', ' + Math.max(1, Math.round(pdfBlob.size / 1024)) + ' KB';
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

  // ---------- início ----------
  if (!SR) $('unsupported').style.display = 'block';
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
