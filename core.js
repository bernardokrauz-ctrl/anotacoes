/* Lógica pura (sem DOM): normalização, interpretação das falas e geração do PDF. */
(function (root) {
  'use strict';

  const DEFAULT_SECTORS = [
    'Geral', 'Acabamento', 'Corte', 'Costura', 'Estamparia', 'Bordado',
    'Almoxarifado', 'Aviamentos', 'Separação', 'Expedição', 'Qualidade',
    'Pack', 'Distribuição', 'Manutenção'
  ];

  function norm(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function cap(s) {
    s = String(s || '').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function titleCase(s) {
    return String(s || '').trim().split(/\s+/).map(cap).join(' ');
  }

  /**
   * Interpreta uma fala.
   * Retorna { sector: string|null, newSector: bool, items: string[] }
   *  - sector: setor declarado na fala ("setor acabamento ...") ou null
   *  - items: textos de notas (já limpos) — pode ser vazio se só declarou o setor
   * "próximo item" / "novo item" / "próxima" separam a fala em várias notas.
   */
  function parseSegment(raw, sectors) {
    let t = String(raw || '').trim();
    const out = { sector: null, newSector: false, items: [] };
    if (!t) return out;

    const n = norm(t);
    const m = n.match(/^(?:(?:o|no|na)\s+)?setor\s+(?:(?:de|do|da)\s+)?/);
    if (m) {
      const rest = t.slice(m[0].length);
      const nrest = norm(rest);
      const list = sectors.filter(s => s !== 'Geral').slice().sort((a, b) => b.length - a.length);
      let found = null;
      for (const s of list) {
        const ns = norm(s);
        if (nrest.startsWith(ns) && (nrest.length === ns.length || /[\s,.:;!?-]/.test(nrest[ns.length]))) {
          found = s;
          t = rest.slice(s.length).replace(/^[\s,.:;!?-]+/, '');
          break;
        }
      }
      if (!found) {
        const words = rest.replace(/[.,:;!?]+$/g, '').trim().split(/\s+/).filter(Boolean);
        if (words.length) {
          const punct = rest.search(/[,.:;!?]/);
          let name, remainder;
          if (punct > 0) {
            name = rest.slice(0, punct);
            remainder = rest.slice(punct + 1);
          } else if (words.length <= 3) {
            name = words.join(' ');
            remainder = '';
          } else {
            name = words[0];
            remainder = words.slice(1).join(' ');
          }
          found = titleCase(name);
          out.newSector = true;
          t = remainder.replace(/^[\s,.:;!?-]+/, '');
        }
      }
      if (found) out.sector = found;
    }

    if (t) {
      t.split(/\b(?:pr[oó]ximo item|novo item|pr[oó]xima)\b[\s,.:;-]*/i)
        .map(x => x.replace(/^[\s,.:;!?-]+|[\s,;-]+$/g, ''))
        .filter(Boolean)
        .forEach(x => out.items.push(cap(x)));
    }
    return out;
  }

  /** Agrupa itens por setor, na ordem da lista de setores (Geral primeiro). */
  function groupItems(items, sectors) {
    const order = sectors.slice();
    items.forEach(i => { if (!order.includes(i.sector)) order.push(i.sector); });
    return order
      .map(name => ({ name, items: items.filter(i => i.sector === name) }))
      .filter(g => g.items.length);
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    const p = x => String(x).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    const p = x => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- dados embutidos no PDF (ida e volta exata) ----------
  const EMBED_TAG = 'VISTORIA1:';

  function toB64(str) {
    const u = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
    return btoa(bin);
  }
  function fromB64(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(u);
  }
  function embedData(v) {
    return EMBED_TAG + toB64(JSON.stringify({
      v: 1, title: v.title, created: v.created,
      items: v.items.map(i => ({ s: i.sector, t: i.text, ts: i.ts }))
    }));
  }

  // ---------- leitura do PDF emitido pelo app ----------
  const WIN1252 = {
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰',
    0x8A: 'Š', 0x8B: '‹', 0x8C: 'Œ', 0x8E: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•',
    0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9A: 'š', 0x9B: '›', 0x9C: 'œ', 0x9E: 'ž', 0x9F: 'Ÿ'
  };
  function winAnsi(str) {
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      out += WIN1252[c] || str[i];
    }
    return out;
  }

  const PDF_DELIM = ' \t\r\n\f\0()<>[]/%';

  // Varre o conteúdo de uma página e devolve os blocos de texto { size, text }.
  // As strings entre parênteses são lidas por inteiro (assim "PALLET" não confunde com o operador ET).
  function scanContent(content, blocks) {
    const n = content.length;
    let i = 0, inBT = false, size = null, parts = [], lastStr = null, prevNum = null;
    const ESC = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
    while (i < n) {
      const c = content[i];
      if (c === '(') {
        let depth = 1, j = i + 1, out = '';
        while (j < n) {
          const d = content[j];
          if (d === '\\') {
            const nx = content[j + 1];
            if (nx >= '0' && nx <= '7') {
              let k = j + 1, oct = '';
              while (k < j + 4 && content[k] >= '0' && content[k] <= '7') oct += content[k++];
              out += String.fromCharCode(parseInt(oct, 8) & 255);
              j = k;
              continue;
            }
            if (nx in ESC) out += ESC[nx];
            else if (nx === '\r' || nx === '\n') { if (nx === '\r' && content[j + 2] === '\n') j++; }
            else out += nx;
            j += 2;
            continue;
          }
          if (d === '(') depth++;
          else if (d === ')') { depth--; if (!depth) break; }
          out += d;
          j++;
        }
        lastStr = out;
        i = j + 1;
        continue;
      }
      if (c === '/') {
        let j = i + 1;
        while (j < n && !PDF_DELIM.includes(content[j])) j++;
        i = j;
        continue;
      }
      if (PDF_DELIM.includes(c)) { i++; continue; }
      let j = i;
      while (j < n && !PDF_DELIM.includes(content[j])) j++;
      const tok = content.slice(i, j);
      i = j;
      if (tok === 'BT') { inBT = true; parts = []; size = null; }
      else if (tok === 'ET') { if (inBT) blocks.push({ size, text: parts.join(' ') }); inBT = false; }
      else if (tok === 'Tf') size = parseFloat(prevNum);
      else if (tok === 'Tj') { if (inBT && lastStr !== null) parts.push(lastStr); lastStr = null; }
      else if (/^-?[\d.]+$/.test(tok)) prevNum = tok;
    }
  }

  function pdfTextBlocks(s) {
    const blocks = [];
    let pos = 0;
    for (;;) {
      const a = s.indexOf('stream', pos);
      if (a < 0) break;
      if (s.slice(a - 3, a) === 'end') { pos = a + 6; continue; }
      let st = a + 6;
      if (s[st] === '\r') st++;
      if (s[st] === '\n') st++;
      const e = s.indexOf('endstream', st);
      if (e < 0) break;
      scanContent(s.slice(st, e), blocks);
      pos = e + 9;
    }
    return blocks;
  }

  function clean(t) { return winAnsi(t).replace(/\s+/g, ' ').trim(); }
  const near = (a, b) => Math.abs(a - b) < 0.05;

  /**
   * Lê um PDF emitido por este app. Devolve { title, created, items:[{sector,text,ts}], exact }.
   *  exact = true quando os nomes de setor vieram dos dados embutidos (não precisam de ajuste de maiúsculas).
   * Lança Error com mensagem para o usuário se não for um PDF do app.
   */
  function parseVistoriaPdf(bytes, opts) {
    opts = opts || {};
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    if (s.slice(0, 5) !== '%PDF-') throw new Error('Esse arquivo não é um PDF.');

    // 1) dados embutidos (PDFs gerados nas versões novas)
    if (!opts.noEmbedded) {
      const m = s.match(/VISTORIA1:([A-Za-z0-9+\/=]+)/);
      if (m) {
        try {
          const d = JSON.parse(fromB64(m[1]));
          if (d && Array.isArray(d.items) && d.items.length) {
            const created = Number(d.created) || Date.now();
            return {
              title: String(d.title || 'Vistoria importada'),
              created,
              exact: true,
              items: d.items.map(i => ({ sector: String(i.s || 'Geral'), text: String(i.t || '').trim(), ts: Number(i.ts) || created }))
                .filter(i => i.text)
            };
          }
        } catch (e) { /* cai para a leitura do texto */ }
      }
    }

    // 2) leitura do texto desenhado no PDF (PDFs antigos)
    const blocks = pdfTextBlocks(s);
    if (!blocks.some(b => near(b.size, 20) && clean(b.text) === 'Relatório de vistoria')) {
      throw new Error(s.includes('/FlateDecode')
        ? 'Esse PDF foi comprimido por outro programa. Use o PDF original, do jeito que o app gerou.'
        : 'Esse PDF não foi gerado pelo app Vistoria por Voz.');
    }

    let subtitle = '', sector = 'Geral';
    const items = [];
    blocks.forEach(b => {
      const text = clean(b.text);
      if (!text) return;
      if (near(b.size, 10.5) && !subtitle) subtitle = text;
      else if (near(b.size, 12.5)) sector = text;
      else if (near(b.size, 11)) items.push({ sector, text });
    });
    if (!items.length) throw new Error('Não encontrei notas nesse PDF.');

    const parts = subtitle.split('•').map(x => x.trim()).filter(Boolean);
    if (parts.length > 1 && /apontamento/i.test(parts[parts.length - 1])) parts.pop();
    const title = parts[0] || 'Vistoria importada';

    let created = Date.now();
    const dm = subtitle.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    const cm = s.match(/\/CreationDate \(D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (dm) created = new Date(+dm[3], +dm[2] - 1, +dm[1], 12, 0, 0).getTime();
    else if (cm) created = new Date(+cm[1], +cm[2] - 1, +cm[3], +cm[4], +cm[5], +cm[6]).getTime();

    return { title, created, exact: false, items: items.map(i => ({ sector: i.sector, text: i.text, ts: created, noTime: true })) };
  }

  /** Nome de setor: usa o já existente (ignorando maiúsculas/acentos) ou capitaliza o que veio em CAIXA ALTA. */
  function resolveSector(name, sectors, exact) {
    const n = norm(name).trim();
    const hit = sectors.find(s => norm(s) === n);
    if (hit) return hit;
    if (exact) return String(name).trim();
    return String(name).trim().toLowerCase()
      .replace(/(^|[\s(\-\/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
      .replace(/\b(De|Da|Do|Das|Dos|E)\b/g, (m, w, off) => (off ? w.toLowerCase() : w));
  }

  /** Monta o PDF (A4) e devolve o objeto jsPDF. */
  function buildPdf(JsPDF, vistoria, sectors) {
    const doc = new JsPDF({ unit: 'mm', format: 'a4' });
    try {
      doc.setProperties({ title: vistoria.title, subject: embedData(vistoria), creator: 'Vistoria por Voz' });
    } catch (e) { /* o PDF sai igual, só sem os dados embutidos */ }
    const W = 210, H = 297, M = 16, bottom = H - 18;
    const contentW = W - M * 2;
    const groups = groupItems(vistoria.items, sectors);
    const TEAL = [27, 42, 73];
    const YELLOW = [255, 200, 61];
    let y = M;

    const footer = () => {
      const n = doc.getNumberOfPages();
      for (let p = 1; p <= n; p++) {
        doc.setPage(p);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(130);
        doc.text(vistoria.title, M, H - 9);
        doc.text(`Página ${p} de ${n}`, W - M, H - 9, { align: 'right' });
      }
    };

    const ensure = (h) => {
      if (y + h > bottom) { doc.addPage(); y = M; }
    };

    // Cabeçalho
    doc.setFillColor(...TEAL);
    doc.rect(0, 0, W, 34, 'F');
    doc.setTextColor(255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.text('Relatório de vistoria', M, 16);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    const dateStr = fmtDate(vistoria.created);
    const head = vistoria.title.includes(dateStr) ? vistoria.title : `${vistoria.title}  •  ${dateStr}`;
    const sub = `${head}  •  ${vistoria.items.length} ${vistoria.items.length === 1 ? 'apontamento' : 'apontamentos'} em ${groups.length} ${groups.length === 1 ? 'setor' : 'setores'}`;
    doc.text(sub, M, 25, { maxWidth: contentW });
    doc.setDrawColor(...YELLOW);
    doc.setLineWidth(0.6);
    doc.setLineDashPattern([2.2, 1.6], 0);
    doc.line(M, 30, W - M, 30);
    doc.setLineDashPattern([], 0);
    y = 46;

    if (!groups.length) {
      doc.setTextColor(90);
      doc.setFontSize(11);
      doc.text('Nenhum apontamento registrado.', M, y);
    }

    groups.forEach(g => {
      ensure(22);
      doc.setFillColor(232, 236, 243);
      doc.rect(M, y - 5.5, contentW, 9, 'F');
      doc.setFillColor(...TEAL);
      doc.rect(M, y - 5.5, 1.8, 9, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12.5);
      doc.setTextColor(...TEAL);
      doc.text(g.name.toUpperCase(), M + 5, y + 0.6);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(110);
      doc.text(`${g.items.length} ${g.items.length === 1 ? 'item' : 'itens'}`, W - M - 2, y + 0.6, { align: 'right' });
      y += 11;

      g.items.forEach(it => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        const lines = doc.splitTextToSize(it.text, contentW - 14);
        const h = lines.length * 5.2 + 3.2;
        ensure(h);
        doc.setDrawColor(120);
        doc.setLineWidth(0.3);
        doc.rect(M + 2, y - 3.4, 3.6, 3.6);
        doc.setTextColor(30);
        doc.text(lines, M + 9, y);
        y += h;
      });
      y += 4;
    });

    footer();
    return doc;
  }

  /**
   * Junta os resultados do reconhecimento de voz num texto só.
   * O Chrome/Android costuma mandar a fala em pedaços cumulativos
   * ("falta", "falta de", "falta de organização"): descarta quem é prefixo do próximo.
   */
  function mergeResults(list) {
    const arr = list.map(s => String(s || '').trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const a = norm(arr[i]);
      const b = i + 1 < arr.length ? norm(arr[i + 1]) : null;
      if (b !== null && b.startsWith(a)) continue;
      out.push(arr[i]);
    }
    return out.join(' ').replace(/\s+/g, ' ').trim();
  }

  const api = { DEFAULT_SECTORS, norm, cap, titleCase, parseSegment, mergeResults, groupItems, fmtDate, fmtTime, buildPdf, parseVistoriaPdf, resolveSector };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VistoriaCore = api;
})(typeof self !== 'undefined' ? self : this);
