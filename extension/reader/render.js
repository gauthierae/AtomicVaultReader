// AtomicVaultReader — Markdown tokens to DOM.
//
// Classic script. Loaded after vendor/marked.umd.js and shared/vault.js.
//
// The XSS rule of Sprint 1 evolves here, it does not relax. Vault text goes to
// marked's *lexer* and comes back as tokens. `marked.parse` is never called, so
// no HTML string ever exists. Every element comes from createElement, every
// character from textContent. That is why this file needs no sanitizer: there is
// no injection path to sanitize.
//
// Two principles govern the token walk:
//   1. Never swallow. An unknown token prints its raw text.
//   2. A wikilink resolves through shared/wikilink.js (Sprint 5). It is a
//      styled literal only when it cannot resolve: no index yet, an empty
//      target, or a path the one path parser refuses.

var RENDER_HEADING_MIN = 1;
var RENDER_HEADING_MAX = 6;

// One entry point. `ctx` carries the state the renderer must not own:
//   ctx.hasFile(path)     -> boolean, from the walked tree
//   ctx.hasDir(path)      -> boolean, from the walked tree
//   ctx.isMd(name)        -> boolean
//   ctx.isImage(name)     -> boolean
//   ctx.onNavigate(path)  -> opens a note
//   ctx.onBroken(href)    -> reports decay, never navigates
//   ctx.getImageUrl(path) -> Promise of an object URL
//   ctx.hasIndex()        -> boolean, is the vault index built yet
//   ctx.idPath(id)        -> a path, or null
//   ctx.stemPaths(stem)   -> an array of paths, possibly empty
//   ctx.onAmbiguous(target, candidates, anchor) -> opens the chooser
function renderMarkdown(container, text, currentPath, ctx) {
  container.textContent = "";

  var source = typeof text === "string" ? text : "";
  var tokens;
  try {
    tokens = marked.lexer(source, { gfm: true });
  } catch (err) {
    // The lexer failed on this note. Show the bytes rather than nothing.
    var fallback = document.createElement("pre");
    fallback.className = "raw-html";
    fallback.textContent = source;
    container.appendChild(fallback);
    return;
  }

  renderBlocks(container, tokens, currentPath, ctx);
}

// --- block tokens ---------------------------------------------------------

function renderBlocks(parent, tokens, path, ctx) {
  if (!tokens) return;
  for (var i = 0; i < tokens.length; i++) renderBlock(parent, tokens[i], path, ctx);
}

function renderBlock(parent, token, path, ctx) {
  switch (token.type) {
    case "space":
      return;

    case "def":
      // The lexer already used it to resolve the reference links.
      return;

    case "checkbox":
      // The list item already owns the checkbox. Printing the token's raw text
      // here would repeat the `[ ]` marker beside it.
      return;

    case "heading":
      var depth = token.depth;
      if (depth < RENDER_HEADING_MIN) depth = RENDER_HEADING_MIN;
      if (depth > RENDER_HEADING_MAX) depth = RENDER_HEADING_MAX;
      var heading = document.createElement("h" + depth);
      renderInline(heading, token.tokens, path, ctx);
      parent.appendChild(heading);
      return;

    case "paragraph":
    case "text":
      var para = document.createElement("p");
      if (token.tokens) renderInline(para, token.tokens, path, ctx);
      else renderText(para, token.text, path, ctx);
      parent.appendChild(para);
      return;

    case "blockquote":
      var quote = document.createElement("blockquote");
      renderBlocks(quote, token.tokens, path, ctx);
      parent.appendChild(quote);
      return;

    case "code":
      var pre = document.createElement("pre");
      var code = document.createElement("code");
      if (token.lang) code.className = "language-" + String(token.lang).split(/\s+/)[0];
      code.textContent = token.text;
      pre.appendChild(code);
      parent.appendChild(pre);
      return;

    case "hr":
      parent.appendChild(document.createElement("hr"));
      return;

    case "list":
      renderList(parent, token, path, ctx);
      return;

    case "table":
      renderTable(parent, token, path, ctx);
      return;

    case "html":
      // Raw HTML in a note is content, not markup. It prints as characters.
      var raw = document.createElement("pre");
      raw.className = "raw-html";
      raw.textContent = token.raw;
      parent.appendChild(raw);
      return;

    default:
      var unknown = document.createElement("p");
      unknown.textContent = token.raw !== undefined ? token.raw : "";
      parent.appendChild(unknown);
      return;
  }
}

function renderList(parent, token, path, ctx) {
  var list = document.createElement(token.ordered ? "ol" : "ul");
  if (token.ordered && token.start && token.start !== 1) list.start = token.start;

  var items = token.items || [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var li = document.createElement("li");

    if (item.task) {
      var box = document.createElement("input");
      box.type = "checkbox";
      box.disabled = true;
      box.checked = !!item.checked;
      li.className = "task-item";
      li.appendChild(box);
    }

    renderItemBody(li, item, token.loose, path, ctx);
    list.appendChild(li);
  }

  parent.appendChild(list);
}

// A tight list item holds its text inline. Wrapping it in a paragraph would add
// spacing the author did not write.
function renderItemBody(li, item, loose, path, ctx) {
  var tokens = item.tokens || [];
  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    if (token.type === "checkbox") continue;
    if (!loose && token.type === "text") {
      if (token.tokens) renderInline(li, token.tokens, path, ctx);
      else renderText(li, token.text, path, ctx);
      continue;
    }
    renderBlock(li, token, path, ctx);
  }
}

function renderTable(parent, token, path, ctx) {
  var table = document.createElement("table");
  var align = token.align || [];

  var thead = document.createElement("thead");
  var headRow = document.createElement("tr");
  var header = token.header || [];
  for (var c = 0; c < header.length; c++) {
    headRow.appendChild(renderCell("th", header[c], align[c], path, ctx));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  var tbody = document.createElement("tbody");
  var rows = token.rows || [];
  for (var r = 0; r < rows.length; r++) {
    var tr = document.createElement("tr");
    for (var i = 0; i < rows[r].length; i++) {
      tr.appendChild(renderCell("td", rows[r][i], align[i], path, ctx));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  parent.appendChild(table);
}

function renderCell(tag, cell, align, path, ctx) {
  var node = document.createElement(tag);
  if (align) node.className = "align-" + align;
  if (cell && cell.tokens) renderInline(node, cell.tokens, path, ctx);
  else if (cell) renderText(node, cell.text, path, ctx);
  return node;
}

// --- inline tokens --------------------------------------------------------

function renderInline(parent, tokens, path, ctx) {
  if (!tokens) return;

  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];

    switch (token.type) {
      case "strong":
      case "em":
      case "del":
        var wrap = document.createElement(token.type === "del" ? "del" : token.type);
        if (token.tokens) renderInline(wrap, token.tokens, path, ctx);
        else renderText(wrap, token.text, path, ctx);
        parent.appendChild(wrap);
        break;

      case "codespan":
        var code = document.createElement("code");
        code.textContent = token.text;
        parent.appendChild(code);
        break;

      case "br":
        parent.appendChild(document.createElement("br"));
        break;

      case "link":
        renderLink(parent, token, path, ctx);
        break;

      case "image":
        renderImage(parent, token, path, ctx);
        break;

      case "html":
        // Inline HTML is text, exactly like a block of it.
        var literal = document.createElement("span");
        literal.className = "raw-html-inline";
        literal.textContent = token.raw;
        parent.appendChild(literal);
        break;

      case "escape":
        parent.appendChild(document.createTextNode(token.text));
        break;

      case "text":
        if (token.tokens) renderInline(parent, token.tokens, path, ctx);
        else renderText(parent, token.text, path, ctx);
        break;

      default:
        renderText(parent, token.raw !== undefined ? token.raw : token.text, path, ctx);
        break;
    }
  }
}

// The Sprint 2 literal, kept for every case a wikilink cannot resolve. A span
// with no handler navigates nowhere.
function renderWikiLiteral(parent, raw) {
  var chip = document.createElement("span");
  chip.className = "wikilink";
  chip.textContent = raw;
  parent.appendChild(chip);
}

// One hit of WIKI_RE becomes one element. The label is the alias when there is
// one, otherwise the target as written — never the resolved path, and never
// the raw [[...]] literal once it resolves.
//
// An embed (the `!` prefix) uses this same table. C6: it inlines nothing, and
// the label gains nothing.
function renderWikilink(parent, match, path, ctx) {
  var parsed = wikiParse(match[2]);

  // C8: an unresolvable index is not decay. Before the index is built, every
  // wikilink stays the literal. It must never read as broken, which would
  // report decay that does not exist. finishIndex repaints the note.
  if (!parsed || !ctx || !ctx.hasIndex || !ctx.hasIndex()) {
    renderWikiLiteral(parent, match[0]);
    return;
  }

  var hit = wikiResolve(parsed.target, ctx);
  var label = parsed.alias || parsed.target;

  if (hit.kind === "inert") {
    renderWikiLiteral(parent, match[0]);
    return;
  }

  // B1: the file exists and the reader cannot open it. Named and inert, the
  // same answer renderLink gives a non-Markdown target. It must never reach
  // ctx.onNavigate — openFile has no vaultIsMarkdown guard, and it would
  // render the bytes of a PNG as Markdown.
  if (hit.kind === "file") {
    var file = document.createElement("span");
    file.className = "link-file";
    file.textContent = label;
    parent.appendChild(file);
    return;
  }

  if (hit.kind === "note") {
    var note = document.createElement("a");
    note.className = "link-note";
    note.href = "#";
    note.dataset.path = hit.path;
    note.textContent = label;
    note.addEventListener("click", function (event) {
      event.preventDefault();
      ctx.onNavigate(event.currentTarget.dataset.path);
    });
    parent.appendChild(note);
    return;
  }

  // C3: a collision is surfaced, never guessed. The human picks.
  if (hit.kind === "ambiguous") {
    var candidates = hit.candidates;
    var choice = document.createElement("a");
    choice.className = "link-ambiguous";
    choice.href = "#";
    choice.dataset.target = parsed.target;
    choice.textContent = label;
    choice.addEventListener("click", function (event) {
      event.preventDefault();
      ctx.onAmbiguous(event.currentTarget.dataset.target, candidates, event.currentTarget);
    });
    parent.appendChild(choice);
    return;
  }

  // C7: broken shows as broken and suggests nothing. Exactly what a broken
  // Markdown link already gets.
  var broken = document.createElement("a");
  broken.className = "link-broken";
  broken.href = "#";
  broken.dataset.href = parsed.target;
  broken.textContent = label;
  broken.addEventListener("click", function (event) {
    event.preventDefault();
    ctx.onBroken(event.currentTarget.dataset.href);
  });
  parent.appendChild(broken);
}

// Every text run passes here, so every wikilink meets the same table.
//
// C2-1: the lexer hands back the source characters, so this is the one place a
// character reference becomes the character it names. Code spans, code blocks,
// raw-HTML literals, the frontmatter block and the Raw view never come through
// here, which is exactly why they keep showing source.
//
// C5: every element still comes from createElement and every character from
// textContent. A target reaches an attribute through dataset alone.
function renderText(parent, raw, path, ctx) {
  if (typeof raw !== "string" || raw.length === 0) return;

  var text = vaultDecodeEntities(raw);

  // m1: WIKI_RE is shared with index.js and carries lastIndex. Reset it.
  WIKI_RE.lastIndex = 0;
  var last = 0;
  var match;

  while ((match = WIKI_RE.exec(text)) !== null) {
    if (match.index > last) {
      parent.appendChild(document.createTextNode(text.slice(last, match.index)));
    }
    renderWikilink(parent, match, path, ctx);
    last = match.index + match[0].length;
  }

  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

// --- links ----------------------------------------------------------------

// CR5-1: `node` is already an <a> at every call site. A null ctx makes
// renderWikilink fall to the inert literal, so a [[...]] run in a label becomes
// a <span> and never a nested anchor. appendChild performs no parser fix-up, so
// a nested anchor would survive and fire two handlers on one click.
function renderLinkLabel(node, token, path, ctx) {
  if (token.tokens && token.tokens.length) renderInline(node, token.tokens, path, ctx);
  else renderText(node, token.text || token.href, path, null);
}

function renderBaseName(path) {
  var cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

function renderLink(parent, token, path, ctx) {
  var target = vaultResolveLink(path, token.href);

  if (target.kind === "external") {
    var external = document.createElement("a");
    external.className = "link-external";
    external.href = target.url;
    external.target = "_blank";
    external.rel = "noopener noreferrer";
    if (token.title) external.title = token.title;
    renderLinkLabel(external, token, path, ctx);
    parent.appendChild(external);
    return;
  }

  if (target.kind === "inert") {
    // javascript:, data:, mailto:, a bare fragment. The label stays, the link
    // does not.
    renderLinkLabel(parent, token, path, ctx);
    return;
  }

  if (target.kind === "vault" && ctx.hasFile(target.path)) {
    var name = renderBaseName(target.path);

    if (ctx.isMd(name)) {
      var note = document.createElement("a");
      note.className = "link-note";
      note.href = "#";
      note.dataset.path = target.path;
      if (token.title) note.title = token.title;
      note.addEventListener("click", function (event) {
        event.preventDefault();
        ctx.onNavigate(event.currentTarget.dataset.path);
      });
      renderLinkLabel(note, token, path, ctx);
      parent.appendChild(note);
      return;
    }

    // A file the reader cannot open. Named and inert, like the greyed tree
    // entries.
    var other = document.createElement("span");
    other.className = "link-file";
    renderLinkLabel(other, token, path, ctx);
    parent.appendChild(other);
    return;
  }

  // C2-2: the target exists and is a folder. That is decay's opposite, so it
  // must not wear the broken style. Named, inert, and marked as a folder.
  if (target.kind === "vault" && ctx.hasDir(target.path)) {
    var folder = document.createElement("span");
    folder.className = "link-folder";
    folder.title = "Folder";
    renderLinkLabel(folder, token, path, ctx);
    parent.appendChild(folder);
    return;
  }

  // Broken, or inside the vault but absent. Vault Rot Phase 1: decay shows and
  // nothing repairs it.
  var broken = document.createElement("a");
  broken.className = "link-broken";
  broken.href = "#";
  broken.dataset.href = typeof token.href === "string" ? token.href : "";
  broken.addEventListener("click", function (event) {
    event.preventDefault();
    ctx.onBroken(event.currentTarget.dataset.href);
  });
  renderLinkLabel(broken, token, path, ctx);
  parent.appendChild(broken);
}

// --- images ---------------------------------------------------------------

function renderHost(url) {
  try {
    return new URL(url).host;
  } catch (err) {
    return url;
  }
}

// Fills a box that already exists. The failed-image path repaints its own box
// with this, which is what keeps one border instead of two (C2-3).
function fillPlaceholder(box, alt, detail) {
  if (alt) {
    var label = document.createElement("span");
    label.className = "img-alt";
    label.textContent = alt;
    box.appendChild(label);
  }

  var note = document.createElement("span");
  note.className = "img-note";
  note.textContent = detail;
  box.appendChild(note);
  return box;
}

function renderPlaceholder(parent, className, alt, detail) {
  var box = document.createElement("div");
  box.className = className;
  fillPlaceholder(box, alt, detail);
  parent.appendChild(box);
  return box;
}

function renderImage(parent, token, path, ctx) {
  var target = vaultResolveLink(path, token.href);
  var alt = vaultDecodeEntities(token.text || "");

  if (target.kind === "external") {
    // No request is made. A remote image is a tracking pixel until proven
    // otherwise, and this extension makes no network call at all.
    renderPlaceholder(parent, "img-remote-blocked", alt, "Remote image not loaded: " + renderHost(target.url));
    return;
  }

  if (target.kind === "vault" && ctx.hasFile(target.path) && ctx.isImage(renderBaseName(target.path))) {
    var box = renderPlaceholder(parent, "img-loading", alt, "Loading " + renderBaseName(target.path));

    ctx.getImageUrl(target.path).then(function (url) {
      var image = document.createElement("img");
      image.className = "note-img";
      image.alt = alt;
      image.src = url;
      box.textContent = "";
      box.className = "img-box";
      box.appendChild(image);
    }).catch(function () {
      // C2-3: repaint this box, never draw a second one inside it.
      box.textContent = "";
      box.className = "img-missing";
      fillPlaceholder(box, alt, "Image not read: " + target.path);
    });
    return;
  }

  var detail = target.kind === "vault" ? "Image not in this vault: " + target.path
    : "Image not in this vault: " + (typeof token.href === "string" ? token.href : "");
  renderPlaceholder(parent, "img-missing", alt, detail);
}
