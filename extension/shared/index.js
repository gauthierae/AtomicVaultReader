// AtomicVaultReader — the in-memory vault index (D-CR-010).
//
// Classic script, loaded after vendor/marked.umd.js and shared/vault.js. Pure:
// no DOM, no chrome.* API, no directory handle. The caller reads the files and
// passes text in; this file only ever computes. The node harness in tests/run.js
// loads it with vm, so every top-level declaration must be `var` or `function`.
//
// Tier 0 by construction. No PKMS artifact is read, present or not. Backlinks
// are derived from real links: lex the note, resolve every link token through
// the one resolver, invert the map.
//
// Sprint 5 replaces the D-INTEROP-001 boundary. Wikilinks still never reach
// indexCollectLinks — they are text runs to the lexer — so this file collects
// the text runs too and resolves them through shared/wikilink.js.

// A note past this size is path-searchable but not content-indexed. Its text is
// never held in memory.
var INDEX_FILE_TEXT_CAP = 262144;

// Cumulative stored text. Each indexed note holds its text and a lowercased
// copy, so the real memory ceiling is about twice this number.
var INDEX_TOTAL_TEXT_CAP = 16777216;

var INDEX_RESULT_CAP = 100;
var INDEX_SNIPPETS_PER_NOTE = 3;
var INDEX_SNIPPET_RADIUS = 40;
var INDEX_QUERY_MIN = 2;
var INDEX_QUERY_MAX = 256;

// --- link extraction ------------------------------------------------------

// Sprint 5. The token types render.js sends through renderText are the types a
// wikilink can live in. These four never reach renderText, so a wikilink
// inside one stays a literal in the reader and must feed no backlink here:
//
//   code, codespan  -> textContent, straight from the token (render.js:94, 223)
//   html            -> textContent of token.raw   (render.js:115, 243)
//   image           -> alt text, never renderText (render.js:415)
//
// `def` is dropped by the renderer as well. That is the masking rule, and it
// costs nothing: the measured occurrences all sit in frontmatter, a fenced
// block, or an inline code span.
var INDEX_TEXT_SKIP = {
  code: true,
  codespan: true,
  html: true,
  image: true,
  escape: true,
  def: true
};

// Collects every text run in a token tree, over the same nesting keys as
// indexCollectLinks. A missed key is a missed backlink.
function indexCollectTextRuns(tokens, out) {
  if (!tokens) return out;

  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    if (!token || typeof token !== "object") continue;
    if (INDEX_TEXT_SKIP[token.type]) continue;

    // A token with children carries no text of its own that the renderer
    // prints. renderText is the else-branch at every call site.
    if (token.tokens) {
      indexCollectTextRuns(token.tokens, out);
    } else if (typeof token.text === "string") {
      out.push(token.text);
    }

    if (token.items) {
      for (var j = 0; j < token.items.length; j++) {
        var item = token.items[j];
        if (item && item.tokens) indexCollectTextRuns(item.tokens, out);
      }
    }

    if (token.header) indexCollectTextRuns(token.header, out);

    if (token.rows) {
      for (var r = 0; r < token.rows.length; r++) indexCollectTextRuns(token.rows[r], out);
    }
  }
  return out;
}

// The first `id:` line of a note's own frontmatter, or null.
//
// m4: `fields` is an array of [key, value] pairs, not an object (vault.js:315).
// A line with no colon arrives as ["", line]. A note with two id: lines keeps
// the first.
//
// D-CR-010 holds: this reads the note, never a PKMS artifact.
function indexFrontmatterId(text) {
  var parsed;
  try {
    parsed = vaultParseFrontmatter(text);
  } catch (err) {
    return null;
  }

  var fields = parsed.fields || [];
  for (var i = 0; i < fields.length; i++) {
    if (fields[i][0] !== "id") continue;
    var value = fields[i][1];
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  return null;
}

// Collects every link token in a token tree. marked nests tokens under several
// different keys, and a missed key is a missed backlink.
function indexCollectLinks(tokens, out) {
  if (!tokens) return out;

  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    if (!token || typeof token !== "object") continue;

    // An image is not a reference between notes. It is an asset the note draws.
    if (token.type === "link") out.push(token.href);

    if (token.tokens) indexCollectLinks(token.tokens, out);

    if (token.items) {
      for (var j = 0; j < token.items.length; j++) {
        var item = token.items[j];
        if (item && item.tokens) indexCollectLinks(item.tokens, out);
      }
    }

    if (token.header) indexCollectLinks(token.header, out);

    if (token.rows) {
      for (var r = 0; r < token.rows.length; r++) indexCollectLinks(token.rows[r], out);
    }
  }
  return out;
}

// Every Markdown note this note links to, as root-relative vault paths.
//
// Frontmatter is stripped first: a `source:` line is metadata, not a link the
// author wrote in the body.
// `wikiCtx` is OPTIONAL, and that is load-bearing (P2-1). indexBuild holds no
// walked tree, so it builds its own ctx and passes it in the second pass. With
// no ctx the wikilink branch does nothing, and the function behaves exactly as
// Sprint 3 left it — which is what protects the two-argument call sites.
function indexExtractTargets(path, text, wikiCtx) {
  var targets = [];
  if (typeof text !== "string" || text.length === 0) return targets;

  var body;
  try {
    body = vaultParseFrontmatter(text).body;
  } catch (err) {
    body = text;
  }

  var tokens;
  try {
    tokens = marked.lexer(body, { gfm: true });
  } catch (err) {
    // The lexer failed on this note. It contributes no links rather than
    // breaking the whole index.
    return targets;
  }

  var hrefs = indexCollectLinks(tokens, []);
  var seen = Object.create(null);

  for (var i = 0; i < hrefs.length; i++) {
    var resolved = vaultResolveLink(path, hrefs[i]);
    if (resolved.kind !== "vault") continue;

    var name = resolved.path.slice(resolved.path.lastIndexOf("/") + 1);
    if (!vaultIsMarkdown(name)) continue;

    // A self-link is not a backlink.
    if (resolved.path === path) continue;

    if (seen[resolved.path]) continue;
    seen[resolved.path] = true;
    targets.push(resolved.path);
  }

  if (!wikiCtx) return targets;

  // --- the wikilink branch (Sprint 5) --------------------------------------
  //
  // Only kind `note` feeds a backlink. Kind `file` names an asset, and an
  // asset is not a reference between notes — the same rule indexCollectLinks
  // already applies to an image.
  var runs = indexCollectTextRuns(tokens, []);

  for (var r = 0; r < runs.length; r++) {
    // renderText decodes entities before it matches, so this must too, or the
    // two sides would disagree about &#91;&#91;x&#93;&#93;.
    var run = vaultDecodeEntities(runs[r]);

    WIKI_RE.lastIndex = 0;
    var match;

    while ((match = WIKI_RE.exec(run)) !== null) {
      var parsed = wikiParse(match[2]);
      if (!parsed) continue;

      var hit = wikiResolve(parsed.target, wikiCtx);
      if (hit.kind !== "note") continue;
      if (hit.path === path) continue;
      if (seen[hit.path]) continue;

      seen[hit.path] = true;
      targets.push(hit.path);
    }
  }

  return targets;
}

// --- build ----------------------------------------------------------------

// `entries` is [{ path, text }] in tree order. A `text` of null means the caller
// skipped the file: too large, unreadable, or past the total cap. Such an entry
// still holds its place in `order`, so a skip is counted and never silent.
function indexBuild(entries) {
  var index = {
    order: [],
    texts: new Map(),
    outgoing: new Map(),
    backlinks: new Map(),
    // Sprint 5.
    ids: new Map(),          // id     -> path, the wikComparePaths winner
    stems: new Map(),        // stem   -> every path with that basename
    duplicateIds: new Map(), // id     -> every claimant, contested ids only
    indexedCount: 0,
    skippedCount: 0
  };
  if (!entries) return index;

  // id -> every path claiming it. Resolved after pass 1, never during it:
  // arrival order is tree order, and tree order is the wrong winner (C3).
  var claims = new Map();

  // --- pass 1: order, texts, stems, id claims -----------------------------
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!entry || typeof entry.path !== "string") continue;

    index.order.push(entry.path);

    // `stems` is built from `order`, NOT from `texts`. A note skipped for size
    // is still a valid link target, and keying off the indexed texts would
    // make large notes silently unreachable.
    var stem = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    var withStem = index.stems.get(stem);
    if (!withStem) {
      withStem = [];
      index.stems.set(stem, withStem);
    }
    withStem.push(entry.path);

    if (typeof entry.text !== "string") {
      index.skippedCount++;
      continue;
    }

    index.indexedCount++;
    index.texts.set(entry.path, { text: entry.text, lower: entry.text.toLowerCase() });

    // m3, a known limit: a size-skipped note claims no id. Its text was never
    // read, so the reader cannot know one. It keeps its stem.
    var id = indexFrontmatterId(entry.text);
    if (id) {
      var claim = claims.get(id);
      if (!claim) {
        claim = [];
        claims.set(id, claim);
      }
      claim.push(entry.path);
    }
  }

  // --- resolve the id claims (C3, P2-5) -----------------------------------
  //
  // duplicateIds holds the CONTESTED ids alone. An id claimed once must not
  // appear: the map exists to surface decay, and one entry per note surfaces
  // nothing.
  claims.forEach(function (paths, id) {
    var sorted = paths.slice().sort(wikiComparePaths);
    index.ids.set(id, sorted[0]);
    if (sorted.length > 1) index.duplicateIds.set(id, sorted);
  });

  // --- pass 2: outgoing links and backlinks -------------------------------
  //
  // This runs after ids and stems are complete. A one-pass build cannot
  // resolve a forward reference and would drop real backlinks.
  var orderSet = new Set(index.order);

  // index.order holds the .md files alone, so this hasFile sees fewer files
  // than the renderer's, which reads the walked tree. A non-Markdown target
  // therefore reads `file` in the renderer and `broken` here. Neither one
  // feeds a backlink, so no backlink changes. Do not repair it by passing the
  // tree in — that would break the purity rule this file holds.
  var wikiCtx = {
    idPath: function (id) { return index.ids.get(id) || null; },
    stemPaths: function (stem) { return index.stems.get(stem) || []; },
    hasFile: function (path) { return orderSet.has(path); }
  };

  for (var k = 0; k < index.order.length; k++) {
    var path = index.order[k];
    var held = index.texts.get(path);
    if (!held) continue;

    var targets = indexExtractTargets(path, held.text, wikiCtx);
    index.outgoing.set(path, targets);

    for (var t = 0; t < targets.length; t++) {
      var sources = index.backlinks.get(targets[t]);
      if (!sources) {
        sources = [];
        index.backlinks.set(targets[t], sources);
      }
      sources.push(path);
    }
  }

  return index;
}

// --- search ---------------------------------------------------------------

// Newlines would break a one-line snippet, so the context collapses to spaces.
function indexFlatten(text) {
  return text.replace(/\s+/g, " ");
}

function indexSnippets(text, lower, needle) {
  var snippets = [];
  var total = 0;
  var at = lower.indexOf(needle);

  while (at !== -1) {
    total++;
    if (snippets.length < INDEX_SNIPPETS_PER_NOTE) {
      var start = at - INDEX_SNIPPET_RADIUS;
      if (start < 0) start = 0;
      var end = at + needle.length + INDEX_SNIPPET_RADIUS;
      if (end > text.length) end = text.length;

      snippets.push({
        before: indexFlatten(text.slice(start, at)),
        // From the original text, so the note's own capitalisation survives.
        match: text.slice(at, at + needle.length),
        after: indexFlatten(text.slice(at + needle.length, end))
      });
    }
    at = lower.indexOf(needle, at + needle.length);
  }

  return { snippets: snippets, total: total };
}

// Returns null for "no search" — a query below the minimum length, or no index
// yet (S3-1: the caller disables the field, but a contract beats an assumption).
// Otherwise an array in `order` order, capped at INDEX_RESULT_CAP.
//
// The array carries a `truncated` flag. Length alone cannot answer the question:
// exactly INDEX_RESULT_CAP matches and a cut list look identical from outside,
// and telling a user their list was cut when it was not is a false statement
// (C3-3). The flag is set only when a match past the cap was actually seen.
function indexSearch(index, query) {
  if (!index || !index.order) return null;
  if (typeof query !== "string") return null;

  var trimmed = query.trim();
  if (trimmed.length < INDEX_QUERY_MIN) return null;
  if (trimmed.length > INDEX_QUERY_MAX) trimmed = trimmed.slice(0, INDEX_QUERY_MAX);

  var needle = trimmed.toLowerCase();
  var results = [];
  results.truncated = false;

  for (var i = 0; i < index.order.length; i++) {
    var path = index.order[i];
    var pathMatch = path.toLowerCase().indexOf(needle) !== -1;
    var held = index.texts.get(path);

    if (!held) {
      // Not content-indexed. A path match still finds it.
      if (!pathMatch) continue;
      if (results.length >= INDEX_RESULT_CAP) {
        results.truncated = true;
        break;
      }
      results.push({ path: path, pathMatch: true, total: 0, snippets: [] });
      continue;
    }

    var found = indexSnippets(held.text, held.lower, needle);
    if (found.total === 0 && !pathMatch) continue;

    if (results.length >= INDEX_RESULT_CAP) {
      results.truncated = true;
      break;
    }

    results.push({
      path: path,
      pathMatch: pathMatch,
      total: found.total,
      snippets: found.snippets
    });
  }

  return results;
}
