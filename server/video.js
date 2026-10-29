// Обработка видео через ffmpeg: любое видео с телефона (в т.ч. HEVC с iPhone) → MP4 H.264, который
// играет во всех браузерах, плюс кадр-обложка. Короткие ролики обрабатываются за несколько секунд.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const tmp = ext => path.join(os.tmpdir(), 'ps-' + crypto.randomBytes(8).toString('hex') + ext);

function run(bin, args, timeoutMs = 10 * 60e3) {
  return new Promise((res, rej) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const tm = setTimeout(() => { p.kill('SIGKILL'); rej(new Error(bin + ' timeout')); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on('error', e => { clearTimeout(tm); rej(e); });
    p.on('close', code => { clearTimeout(tm); code === 0 ? res(out) : rej(new Error(bin + ' exit ' + code + ': ' + err.slice(-400))); });
  });
}

async function probe(file) {
  try {
    const j = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], 60e3));
    const v = (j.streams || []).find(s => s.codec_type === 'video') || {};
    return { codec: v.codec_name || '', width: v.width || 0, height: v.height || 0, pix: v.pix_fmt || '', duration: Number(j.format && j.format.duration) || 0 };
  } catch (e) { return { codec: '', width: 0, height: 0, duration: 0 }; }
}

// Возвращает запись для галереи: "video:URL poster=URL"
async function processVideo(inputFile, keyBase) {
  const info = await probe(inputFile);
  const out = tmp('.mp4'), poster = tmp('.jpg');
  try {
    const simple = info.codec === 'h264' && (!info.pix || info.pix === 'yuv420p') && Math.max(info.width, info.height) <= 1920;
    const args = simple
      ? ['-y', '-i', inputFile, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out]
      : ['-y', '-i', inputFile, '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out];
    try { await run(FFMPEG, args); }
    catch (e) { if (!simple) throw e; await run(FFMPEG, ['-y', '-i', inputFile, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', out]); }
    const at = info.duration > 1.2 ? '0.5' : '0';
    await run(FFMPEG, ['-y', '-ss', at, '-i', out, '-frames:v', '1', '-vf', "scale='min(1080,iw)':-2", '-q:v', '3', poster], 120e3);
    const vUrl = await storage.putMedia(keyBase + '.mp4', fs.readFileSync(out), 'video/mp4');
    const pUrl = fs.existsSync(poster) ? await storage.putMedia(keyBase + '.jpg', fs.readFileSync(poster), 'image/jpeg') : '';
    return 'video:' + vUrl + (pUrl ? ' poster=' + pUrl : '');
  } finally {
    [out, poster].forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
  }
}

module.exports = { processVideo, probe, tmp };
