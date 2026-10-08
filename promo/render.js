/* Renders the promo film offscreen, frame by frame.
 *   electron promo/render.js out/            → out/frames/*.png + out/audio.wav
 *   electron promo/render.js out/ 1.5,12,20  → just those stills (seconds)  */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const FPS = 30;
const [outDir = path.join(__dirname, 'out'), stills] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    useContentSize: true,
    webPreferences: { offscreen: true, partition: 'promo', backgroundThrottling: false },
  });
  win.webContents.setFrameRate(60);
  await win.loadFile(path.join(__dirname, 'index.html'));
  const run = (js) => win.webContents.executeJavaScript(js);
  const { duration } = await run('window.promoReady');

  // Offscreen frames arrive through 'paint' (capturePage can hand back an
  // older frame). The page stamps the frame number into its bottom-right
  // pixel; each shot waits until the latest paint carries this frame's stamp.
  let latest = null;
  win.webContents.on('paint', (_e, _dirty, image) => { latest = image; });
  const stampOf = (image) => {
    const { width, height } = image.getSize();
    const px = image.crop({ x: width - 1, y: height - 1, width: 1, height: 1 }).toBitmap(); // BGRA
    return px[2] + (px[1] << 8);
  };
  let mark = 0;
  const shot = async (t, file) => {
    mark = (mark % 65535) + 1;
    await run(`renderAt(${t}, ${mark})`);
    win.webContents.invalidate();
    for (let waited = 0; waited < 5000; waited += 8) {
      if (latest && stampOf(latest) === mark) {
        fs.writeFileSync(file, latest.toPNG());
        return;
      }
      await new Promise((r) => setTimeout(r, 8));
    }
    throw new Error(`frame at ${t}s never painted`);
  };

  fs.mkdirSync(outDir, { recursive: true });
  if (stills) {
    for (const t of stills.split(',').map(Number)) await shot(t, path.join(outDir, `still-${t}.png`));
  } else {
    const frames = path.join(outDir, 'frames');
    fs.rmSync(frames, { recursive: true, force: true });
    fs.mkdirSync(frames, { recursive: true });
    const n = Math.round(duration * FPS);
    for (let i = 0; i < n; i++) {
      await shot(i / FPS, path.join(frames, `f${String(i).padStart(4, '0')}.png`));
      if (i % 150 === 0) console.log(`frame ${i}/${n}`);
    }
    fs.writeFileSync(path.join(outDir, 'audio.wav'), Buffer.from(await run('renderAudio()'), 'base64'));
    console.log('done', n, 'frames');
  }
  app.exit(0);
});
