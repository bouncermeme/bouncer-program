/*
  The reviewer packet's Markdown, as plain HTML (app/review). Only what the
  repository's documents use: headings, paragraphs, lists, tables, fenced
  code, block quotes, rules, and inline code, bold and links. Every character
  of the source is escaped before any tag is added, so a document cannot
  inject markup. Links to other sites open as links; a repository path is
  shown as text, since the site does not serve the repository.
*/

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function inline(raw: string): string {
  const codes: string[] = [];
  let s = raw.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string) => `[image: ${alt}]`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, href: string) =>
    /^https?:\/\//i.test(href.replace(/&amp;/g, "&")) ? `<a href="${href}" rel="noopener noreferrer" target="_blank">${text}</a>` : `${text} (<code>${href}</code>)`,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isRule = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
const listMarker = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/* Markdown to HTML. `shift` moves heading levels down (a document's # becomes h2 under the page's own h1). */
export function markdownToHtml(md: string, shift = 1): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w-]*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code${fence[2] ? ` data-lang="${esc(fence[2])}"` : ""}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(6, h[1].length + shift);
      const text = inline(h[2].trim());
      out.push(`<h${level} id="${slugify(h[2])}">${text}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<div class="packet-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${markdownToHtml(body.join("\n"), shift)}</blockquote>`);
      continue;
    }
    if (listMarker.test(line)) {
      /* Items with their continuation lines; deeper indentation nests. */
      const items: { indent: number; ordered: boolean; text: string }[] = [];
      while (i < lines.length && lines[i].trim()) {
        const m = lines[i].match(listMarker);
        if (m) items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
        else if (items.length && /^\s+/.test(lines[i])) items[items.length - 1].text += " " + lines[i].trim();
        else break;
        i++;
      }
      const html: string[] = [];
      const stack: { indent: number; tag: string }[] = [];
      for (const it of items) {
        while (stack.length && it.indent < stack[stack.length - 1].indent) html.push(`</li></${stack.pop()!.tag}>`);
        const top = stack[stack.length - 1];
        if (!top || it.indent > top.indent) {
          const tag = it.ordered ? "ol" : "ul";
          stack.push({ indent: it.indent, tag });
          html.push(`<${tag}><li>${inline(it.text)}`);
        } else html.push(`</li><li>${inline(it.text)}`);
      }
      while (stack.length) html.push(`</li></${stack.pop()!.tag}>`);
      out.push(html.join(""));
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*(```|~~~)/.test(lines[i]) && !listMarker.test(lines[i]) && !(isTableRow(lines[i]) && isRule(lines[i + 1] ?? "")) && !/^\s*>/.test(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}
