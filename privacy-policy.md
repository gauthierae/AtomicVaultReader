# Privacy Policy — AtomicVaultReader

**Last updated**: 2026-09-08 · **Applies to**: source build 0.4.0

AtomicVaultReader is a Chrome extension. It reads a folder of Markdown notes on your device and lets you move between them.

## Data collection

AtomicVaultReader does **not** collect, transmit or share any personal data. There is no server and no account. No operator of this extension receives anything about you or about your notes.

## Data storage

Everything the extension stores lives on your own device. It never uploads any of it.

### The vault folder

You grant the extension one folder with the Chrome folder picker. The extension keeps a reference to that folder in IndexedDB, inside the extension's own storage. That reference lets the reader reopen the same folder after a restart. Chrome asks you to confirm the grant again after each restart. The extension cannot open the folder without that click.

The extension reads the `.md` files in that folder and the image files that a note links to. It never writes, moves, renames or deletes a file in that folder.

### Other values the extension keeps

Four values sit in Chrome local storage. None of them holds the text of a note.

- the path of the last note you read, relative to the vault folder, so the reader reopens it
- your theme choice: follow the system, light or dark
- your layout: the width of the file tree, whether the tree is hidden, and which folders are open
- the id of the reader tab, for the time the browser session lasts. It lets the toolbar icon focus the open tab instead of a second one

## Network requests

The extension makes **no network request of any kind**. It sends no analytics, no crash reports and no usage data. It calls no service.

A note can link to an image on a remote host. The extension does **not** load that image. It shows a placeholder with the host name instead. An image inside the vault folder loads from your disk.

## Permissions

The extension requests one permission. It uses it only for the stated purpose.

| Permission | Purpose |
|---|---|
| `storage` | Remember the last note, the theme and the layout, on your device |

Access to your vault folder comes from the folder picker, not from a manifest permission. The extension holds no host permission. It cannot read your browsing history, your cookies or any other tab.

## Delete your data

Choose **Change vault** in the toolbar to replace the stored folder reference. Remove the extension from Chrome to erase everything it stores. Your notes stay where they are. The extension never changed them.

## Contact

This is an open-source project. File your questions and issues at
[github.com/gauthierae/AtomicVaultReader](https://github.com/gauthierae/AtomicVaultReader).
