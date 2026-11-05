// Minimal, escape-first markdown for agent answers: headings, lists, tables, bold, italics, code.
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');

export function md(src = '') {
  const out = [];
  let list = null;
  const lines = src.split('\n');
  const close = () => list && (out.push(`</${list}>`), (list = null));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      close();
      const row = (r, tag) => '<tr>' + r.trim().replace(/^\||\|$/g, '').split('|').map((c) => `<${tag}>${inline(c.trim())}</${tag}>`).join('') + '</tr>';
      let html = '<table><thead>' + row(l, 'th') + '</thead><tbody>';
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) html += row(lines[i++], 'td');
      i--;
      out.push(html + '</tbody></table>');
    } else if (/^#{1,4}\s/.test(l)) {
      close();
      out.push(`<h4>${inline(l.replace(/^#+\s/, ''))}</h4>`);
    } else if (/^\s*[-*]\s/.test(l) || /^\s*\d+\.\s/.test(l)) {
      const kind = /^\s*\d+\./.test(l) ? 'ol' : 'ul';
      if (list !== kind) (close(), out.push(`<${kind}>`), (list = kind));
      out.push(`<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>`);
    } else if (!l.trim()) close();
    else (close(), out.push(`<p>${inline(l)}</p>`));
  }
  close();
  return out.join('');
}
