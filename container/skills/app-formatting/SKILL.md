---
name: app-formatting
description: Formatting for the native NanoClaw app channel. Use when replying to a message whose origin (`from=`) starts with `app-`, e.g. `app-alex-home` or `app-alex-family`.
---

# App channel formatting

Messages from a destination named `app-…` come from the native phone/tablet app. The app renders full Markdown, so use it when it helps the reader:

- Headings (`##`) to title a brief or a report; skip them for a one-line answer.
- Bullet, numbered and check lists (`- [ ]` / `- [x]`).
- Tables for anything with columns (dates and times, amounts, status per item).
- `inline code` and fenced code blocks for commands, paths and IDs.
- Links as `[text](url)`.

Files you send (images, PDFs) appear inline: images as pictures, other files as tappable cards. To offer choices, ask with your question tool; the options become buttons on the card, and the person's tap comes back to you.

The first line of a message is what shows on the lock screen when it arrives as a notification, so make it say what the message is about ("Evening brief: 3 things for tomorrow", not "Here you go!").
