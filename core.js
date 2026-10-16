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

  /** Monta o PDF (A4) e devolve o objeto jsPDF. */
  function buildPdf(JsPDF, vistoria, sectors) {
    const doc = new JsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, H = 297, M = 16, bottom = H - 18;
    const contentW = W - M * 2;
    const groups = groupItems(vistoria.items, sectors);
    const TEAL = [15, 118, 110];
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
    y = 46;

    if (!groups.length) {
      doc.setTextColor(90);
      doc.setFontSize(11);
      doc.text('Nenhum apontamento registrado.', M, y);
    }

    groups.forEach(g => {
      ensure(22);
      doc.setFillColor(230, 244, 242);
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

  const api = { DEFAULT_SECTORS, norm, cap, titleCase, parseSegment, groupItems, fmtDate, fmtTime, buildPdf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VistoriaCore = api;
})(typeof self !== 'undefined' ? self : this);
