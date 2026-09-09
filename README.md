# AtomicVaultReader

AtomicVaultReader is a Chrome extension. It reads a folder of Markdown notes and lets you move between them. Follow a link, walk the backlinks, search the whole vault. Nothing leaves your machine.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

**Source build: 0.4.0** (this repo). The extension is not yet on the Chrome Web Store.

## What it does

- Grant one folder once. The reader opens the same vault at every launch
- Walk a sorted file tree. Folders remember whether they are open
- Render Markdown: headings, lists, tables, code blocks, task lists
- Follow a Markdown link or a `[[wikilink]]` to another note in the vault
- Resolve a wikilink by ID, by path, by file name or by alias. A chooser opens when two notes share a name
- See every note that links to the current one, in the **Linked from** pane
- Search the whole vault as you type
- Show or hide the YAML frontmatter of a note
- Jump inside a long note with the **On this page** outline
- Expand or collapse every folder with one control
- Light or dark theme
- Everything stays on your device: no server, no account, no network request

The reader never writes to your files. It cannot move, rename or repair a note.

## Install

### From source

The extension is not yet on the Chrome Web Store. Install it from this repository.

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Turn on **Developer mode** with the toggle at the top right
4. Choose **Load unpacked**, then select the `extension/` folder
5. The AtomicVaultReader icon appears in your toolbar

> **About the Chrome warning.** After a source install, Chrome raises a "Disable developer mode extensions" popup at each start. Every unpacked extension triggers that notice. It is not specific to AtomicVaultReader. Click Cancel, or dismiss it. The tool continues to work.

## Use

### Open a vault

1. Click the AtomicVaultReader toolbar icon. The reader opens in its own tab
2. Choose **Grant vault** and select the folder that holds your notes
3. The file tree appears on the left. Click a note to read it

Chrome forgets the grant when it restarts. The reader then shows a **Reopen vault** screen. One click restores the same folder. You do not choose it again.

Choose **Change vault** in the toolbar to point the reader at a different folder.

### Move between notes

- Click a link in a note to open the target note
- Click a name in the **Linked from** pane to go to a note that links here
- Type in the search box. A results list replaces the tree. Clear the box to get the tree back

### The toolbar

| Control | What it does |
|---|---|
| Expand all folders | Opens every folder. Click again to collapse every folder |
| Hide the file tree | Gives the whole width to the note. Click again to show the tree |
| Show the frontmatter | Reveals the YAML block at the top of the note. Grey when the note has none |
| Show the table of contents | Opens the **On this page** outline. Grey when the note has one heading or fewer |
| Theme | Cycles **follow the system → light → dark** |

Drag the edge of the file tree to resize it. The reader remembers the width, the hidden state and the open folders.

### Light and dark

The reader follows your system light or dark setting where the browser reports it. Some Chrome builds do not pass that setting to an extension page, so the reader ships a theme control in its toolbar. Click it to cycle **follow the system → light → dark**. Your choice is remembered.

## Limits

- The reader lists `.md` files only. Other files stay hidden in the tree
- An image inside the vault renders. An image on a remote host does not load. The reader shows a placeholder with the host name instead. This is by design: no request leaves your machine
- Inline HTML in a note appears as text. The reader never runs HTML from a note
- The reader is read-only. Edit your notes in your editor of choice

## Privacy

AtomicVaultReader keeps a reference to your vault folder, the path of the last note you read, your theme choice and your layout choices. All of it lives in Chrome storage, on your own device. No account, no cloud sync, no server. Nothing about you, and nothing in your notes, ever reaches the developer. The extension sends no analytics, no crash reports and no telemetry. It makes no network request of any kind.

Read [privacy-policy.md](privacy-policy.md) for the full detail.

## Permissions

AtomicVaultReader requests one permission and nothing else.

| Permission | Why the extension needs it |
|---|---|
| `storage` | Remembers the last note, the theme and the layout, on your device |

Access to your vault folder is not a manifest permission. You grant it yourself with the folder picker. Chrome asks you again after a restart. No host permissions. No `tabs`. No `webRequest`. The extension cannot read your browsing history or your cookies.

## Credits

Markdown parser: [marked](https://github.com/markedjs/marked), MIT License. Copyright (c) 2018-2026 MarkedJS, (c) 2011-2018 Christopher Jeffrey. The licence text ships with the extension at `extension/vendor/marked.LICENSE.txt`.

## License

MIT — see [LICENSE](LICENSE)
