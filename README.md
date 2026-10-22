# Party Machines Booth (web app)

A 360-booth kiosk that runs in Safari and installs to the iPhone Home Screen. No App Store, no Xcode.

**How it flows:** Welcome → *Start new event* (copy settings from any past event, tweak them, create) → each event has **Start recording** and **Videos** (save to Photos, .zip, leads, highlight reel). Past events sit in a dropdown at the bottom of the home screen.

**Leave-it-on-the-booth mode:** put the phone on the 360 platform, start the booth, and when the platform moves the phone detects it, shows a short countdown on the camera (Settings → *Start recording after movement*, 0–10 s) and records. Use *Test movement* in settings to tune Sensitivity. Pick the front or back camera and a *Wide* picture shape (no zoom).

**What works:** motion trigger + tap start, countdown ring, recording, speed-ramp / boomerang / no effect,
border + logo overlay, music bed with fade, lead capture (email / WhatsApp), per-event library,
highlight reel, Save-to-Photos batches via the share sheet, `.zip` and `leads.csv` export,
operator PIN (SHA-256), hidden 3-second exit corner, kiosk state survives a restart, offline after first load.

**What a browser cannot do** (the native Xcode app in `../party-machine-booth` can): the offline QR download
(a web page can't run a server), 4K / 120 fps capture, and instant background processing.
Videos are finished on the phone in real time, so a 12 s clip takes about 15 s to process.

## Put it on the phone
1. Publish this folder with GitHub Pages (Settings → Pages → Deploy from branch → `main` / root).
2. On the iPhone open the Pages link in **Safari** → Share → **Add to Home Screen** → open it from the icon.
3. Allow **Camera**, **Microphone** and **Motion & Orientation** when asked.
4. For a locked kiosk: triple-click the side button to start **Guided Access**.

Camera and motion sensors only work over **https** (GitHub Pages is https) or on `localhost`.

## Test on a computer
```bash
python3 -m http.server 8123   # then open http://localhost:8123
```

## Files
`index.html` the whole app · `sw.js` offline cache (bump `VERSION` to force an update) · `manifest.webmanifest` · icons
