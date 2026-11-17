// SPDX-License-Identifier: AGPL-3.0-only
// Pure: an issue written as Markdown, as the HTML a newsletter tool sends. Everything is escaped
// first, then a small fixed set is turned back on: paragraphs, headings, lists, bold, italic and
// links to http or https. Raw HTML, scripts and images never come through.
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function inline(text: string): string {
  return escape(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => `<a href="${url}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

export function renderIssue(markdown: string): string {
  const out: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (const raw of markdown.replaceAll("\r\n", "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^\d+\.\s+(.+)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      const level = heading[1]!.length + 1;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join("\n");
}
