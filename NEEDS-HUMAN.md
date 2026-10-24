# NEEDS HUMAN

Most important first. Nothing here has been verified on real hardware by the build agent.

1. **Desk View camera:** open `http://localhost:3000` in Chrome, allow the camera, open the camera dropdown on the Setup page. Is "Desk View" listed? If not, use the iPhone as a plain Continuity Camera aimed at the desk, **wired over USB**.
2. **Krita paints from the helper on the real Mac:** grant Accessibility + Input Monitoring to Terminal, run `npm run helper`, Krita open beside the Chrome strip, rest your hand: does a stroke land in Krita?
3. **API keys missing:** create `.env.local` with `CARTESIA_API_KEY=...` and `ANTHROPIC_API_KEY=...`, then restart `npm run dev`. Until then voice and the Claude fallback run on mocks and the status bar says "key missing".
