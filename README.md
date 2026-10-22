# Party Machines Booth (web app)

A 360-booth kiosk that runs in Safari and installs to the iPhone Home Screen. No App Store, no Xcode.

**How it flows:** Welcome → *Start new event* (copy settings from any past event, tweak them, create) → each event has **Start recording** and **Videos** (save to Photos, .zip, leads, highlight reel). Past events sit in a dropdown at the bottom of the home screen.

**Leave-it-on-the-booth mode:** put the phone on the 360 platform, start the booth, and when the platform moves the phone detects it, shows a short countdown on the camera (Settings → *Start recording after movement*, 0–10 s) and records. Use *Test movement* in settings to tune Sensitivity. Pick the front or back camera and a *Wide* picture shape (no zoom).

**Silent videos:** the app never records sound (it never asks for the microphone). The only audio in a video is the music you add in settings.

**Processing safety:** every step has a time limit, a *Skip effects* button appears if it drags, and a video always ends up on the review screen (with a note if effects were skipped). Review has a **Share** button in the top-right corner (AirDrop, WhatsApp, Messages, Save Video to Photos). A web app cannot save to Photos silently — that needs the share sheet or the native app.

**Speed editor (v4):** in settings, *Speed, slow-mo & fast-forward* lets you add any number of sections — each with a start, an end and a speed from 0.25× to 4× — shown on a timeline with the finished length. Quick-style presets (Classic 360, Slow-mo moment, Party fast, Boomerang, Real time) fill it in for you.

**Overlay photo:** a transparent PNG is laid over the video at exactly the video's size (3:4 = 1080×1440, or 9:16 = 1080×1920). Settings checks the image (shape and see-through area) and previews it.

**Also in v4:** caption text on the video, mirror-front-camera switch, auto-return from the review screen, and an **End-of-event summary** (videos, total time, leads, shares, busiest hours, share/export).

**v4.1:** *Ready check* (camera, movement sensor, screen-awake, storage, battery, waiting screen); screen stays awake while the booth runs (Wake Lock, with a silent-video fallback for older iPhones); a *Waiting screen* that plays your photos/videos when nobody is using the booth and switches to the camera on movement or a tap; 60 fps capture that never trades away the full 3:4 view; Videos thumbnails show the 3rd second.

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
