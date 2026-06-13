/**
 * Make an arbitrary video file streamable for MediaSource playback, so the
 * receiver can play it WHILE it downloads instead of waiting for the whole file.
 *
 * Strategy (best result first, each falls back safely to the next):
 *   1. WebM            -> already streamable, pass through.
 *   2. MP4 / MOV       -> fast LOSSLESS remux to fragmented MP4 (mp4box.js),
 *                         validated against a real MediaSource append.
 *   3. anything else   -> transcode to WebM (MediaRecorder + WebAudio).
 *   4. give up         -> return the original file (receiver downloads-then-plays).
 *
 * Returns: { blob, mimeType, fileName, streamable }.
 * Never throws — every tier is wrapped, so it can't block the upload.
 */

let _mp4boxPromise = null;
function loadMP4Box() {
  if (!_mp4boxPromise) _mp4boxPromise = import('https://esm.sh/mp4box@0.5.2');
  return _mp4boxPromise;
}

function stripExt(name) { return name.replace(/\.[^.]+$/, ''); }

const hasMSE = typeof MediaSource !== 'undefined';

export async function ensureStreamable(file, { log = () => {}, onProgress = () => {} } = {}) {
  const type = (file.type || '').toLowerCase();

  // 1. Already a streamable container.
  if (/webm/.test(type)) {
    return { blob: file, mimeType: file.type || 'video/webm', fileName: file.name, streamable: true };
  }

  // 2. Fast lossless remux to fragmented MP4 (works for H.264/AAC etc.).
  try {
    const remux = await remuxToFragmentedMp4(file, log);
    if (remux && await isPlayableMSE(remux.bytes, remux.mimeType)) {
      log(`Remuxed to fragmented MP4 (${remux.mimeType})`, 'confirmed');
      return {
        blob: new Blob([remux.bytes], { type: 'video/mp4' }),
        mimeType: remux.mimeType,
        fileName: stripExt(file.name) + '.mp4',
        streamable: true
      };
    }
    if (remux) log('Remux produced an unplayable result; transcoding instead', 'retry');
  } catch (err) {
    log(`Remux failed (${err.message || err}); transcoding instead`, 'retry');
  }

  // 3. Transcode to WebM (handles anything the browser can decode, incl. HEVC).
  try {
    log('Transcoding to WebM (plays through once, real time)…', 'pending');
    const webm = await transcodeToWebm(file, onProgress);
    if (webm && webm.blob && webm.blob.size > 0) {
      log(`Transcoded to WebM (${webm.mimeType})`, 'confirmed');
      return { blob: webm.blob, mimeType: webm.mimeType, fileName: stripExt(file.name) + '.webm', streamable: true };
    }
  } catch (err) {
    log(`Transcode failed (${err.message || err}); uploading original`, 'error');
  }

  // 4. Give up — original file, receiver will download-then-play.
  return { blob: file, mimeType: file.type || 'application/octet-stream', fileName: file.name, streamable: false };
}

// ----------------------------------------------------------------------------
// Tier 2: mp4box remux to a single fragmented-MP4 byte stream
// ----------------------------------------------------------------------------
async function remuxToFragmentedMp4(file, log) {
  const mod = await loadMP4Box();
  const MP4Box = mod.default || mod;
  const input = await file.arrayBuffer();

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const fail = (e) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); } };
    const guard = setTimeout(() => fail(new Error('remux timeout')), 20000);

    const mp4 = MP4Box.createFile();
    const parts = [];        // ordered ArrayBuffers: init segment(s) then media segments
    let mimeType = null;

    mp4.onError = (e) => { clearTimeout(guard); fail(e); };

    mp4.onReady = (info) => {
      try {
        const codecs = info.tracks.map(t => t.codec).filter(Boolean).join(', ');
        mimeType = `video/mp4; codecs="${codecs}"`;
        if (!hasMSE || !MediaSource.isTypeSupported(mimeType)) {
          clearTimeout(guard);
          return fail(new Error('codec not MSE-supported: ' + mimeType));
        }
        for (const t of info.tracks) {
          mp4.setSegmentOptions(t.id, null, { nbSamples: 1000 });
        }
        const initSegs = mp4.initializeSegmentation();
        for (const seg of initSegs) parts.push(seg.buffer);
        mp4.start();
      } catch (e) { clearTimeout(guard); fail(e); }
    };

    mp4.onSegment = (id, user, buffer /*, sampleNum, last */) => {
      parts.push(buffer);
    };

    try {
      input.fileStart = 0;
      mp4.appendBuffer(input);
      mp4.flush();
      // After flush, all segments have been emitted synchronously by mp4box.
      clearTimeout(guard);
      if (!mimeType || parts.length === 0) return fail(new Error('no segments produced'));
      const total = parts.reduce((n, b) => n + b.byteLength, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const b of parts) { out.set(new Uint8Array(b), off); off += b.byteLength; }
      finish({ bytes: out, mimeType });
    } catch (e) { clearTimeout(guard); fail(e); }
  });
}

// Append bytes to a real MediaSource SourceBuffer and confirm it decodes
// without error — the definitive "is this actually streamable" check.
function isPlayableMSE(bytes, mimeType) {
  return new Promise((resolve) => {
    if (!hasMSE || !MediaSource.isTypeSupported(mimeType)) return resolve(false);
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const to = setTimeout(() => done(false), 5000);

    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    const video = document.createElement('video');
    video.muted = true;
    video.src = url;

    ms.addEventListener('sourceopen', () => {
      try {
        const sb = ms.addSourceBuffer(mimeType);
        sb.addEventListener('error', () => { clearTimeout(to); URL.revokeObjectURL(url); done(false); });
        sb.addEventListener('updateend', () => {
          clearTimeout(to);
          // Appended without error and got a positive duration -> playable.
          const ok = Number.isFinite(ms.duration) ? ms.duration > 0 : true;
          URL.revokeObjectURL(url);
          done(ok);
        });
        sb.appendBuffer(bytes.buffer ? bytes : new Uint8Array(bytes));
      } catch {
        clearTimeout(to); URL.revokeObjectURL(url); done(false);
      }
    });
  });
}

// ----------------------------------------------------------------------------
// Tier 3: transcode to WebM via MediaRecorder (plays the file through once)
// ----------------------------------------------------------------------------
async function transcodeToWebm(file, onProgress) {
  const mimeCandidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mime = (typeof MediaRecorder !== 'undefined' && mimeCandidates.find(m => MediaRecorder.isTypeSupported(m))) || null;
  if (!mime) throw new Error('MediaRecorder/WebM not supported');

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.playsInline = true;
  // Audio is captured silently via WebAudio (createMediaElementSource reroutes
  // output into the graph), so the conversion is not audible to the user.

  let audioCtx = null;
  try {
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('cannot decode source video'));
    });

    const stream = (video.captureStream ? video.captureStream() : video.mozCaptureStream?.());
    if (!stream) throw new Error('captureStream unsupported');

    const tracks = [];
    const vtrack = stream.getVideoTracks()[0];
    if (vtrack) tracks.push(vtrack);

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const srcNode = audioCtx.createMediaElementSource(video);
      const dest = audioCtx.createMediaStreamDestination();
      srcNode.connect(dest); // NOT connected to audioCtx.destination -> silent
      const atrack = dest.stream.getAudioTracks()[0];
      if (atrack) tracks.push(atrack);
      if (audioCtx.state === 'suspended') await audioCtx.resume();
    } catch { /* no audio track — video only */ }

    const mixed = new MediaStream(tracks);
    const rec = new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: 1500000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const recStopped = new Promise((res) => { rec.onstop = res; });

    rec.start(500);
    await video.play();

    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    const progTimer = setInterval(() => {
      if (dur > 0) onProgress(Math.min(99, (video.currentTime / dur) * 100));
    }, 250);

    await new Promise((res) => { video.onended = res; });
    clearInterval(progTimer);
    onProgress(100);

    rec.stop();
    await recStopped;
    // Report the ACTUAL codec'd mime (e.g. video/webm;codecs="vp8,opus") — a
    // bare "video/webm" is not accepted by MediaSource.isTypeSupported.
    const actualMime = (rec.mimeType && /codecs/i.test(rec.mimeType)) ? rec.mimeType : mime;
    return { blob: new Blob(chunks, { type: actualMime }), mimeType: actualMime };
  } finally {
    try { video.pause(); } catch {}
    try { audioCtx && audioCtx.close(); } catch {}
    URL.revokeObjectURL(url);
  }
}
