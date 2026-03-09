#!/usr/bin/env node
/**
 * OpenClaw 릴리즈 배너 생성기 (1200x630)
 *
 * Usage:
 *   node banner.js 2026.3.7
 *   node banner.js 2026.3.7 "ContextEngine 플러그인" "ACP 영속화" "Telegram 토픽 라우팅"
 *
 * Output:
 *   /tmp/openclaw-{버전}-banner.jpg
 */

let sharp;
try {
  sharp = require('sharp');
} catch {
  sharp = require('/opt/homebrew/lib/node_modules/openclaw/node_modules/sharp');
}

const version = process.argv[2] || '2026.x.x';
const customBullets = process.argv.slice(3);

const OUT = `/tmp/openclaw-${version}-banner.jpg`;
const WIDTH = 1200;
const HEIGHT = 630;

// 기본 불릿 (인자가 없으면 비워둠 — 호출자가 채워야 함)
const bullets = customBullets.length > 0 ? customBullets : [
  'Major feature update',
  'See release notes for details',
];

function escape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const bulletLines = bullets.slice(0, 6).map((b, i) => `
  <text x="72" y="${310 + i * 46}" font-family="sans-serif" font-size="22" fill="#cccccc">● ${escape(b)}</text>
`).join('');

const svg = `
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a0505"/>
      <stop offset="100%" stop-color="#0d0000"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <!-- 상단 강조선 -->
  <rect x="0" y="0" width="${WIDTH}" height="5" fill="#e84040"/>
  <!-- 타이틀 -->
  <text x="64" y="130" font-family="sans-serif" font-size="80" font-weight="bold" fill="#e84040">OpenClaw</text>
  <!-- 버전 -->
  <text x="68" y="185" font-family="sans-serif" font-size="30" fill="#aaaaaa">v${escape(version)} Release Notes</text>
  <!-- 구분선 -->
  <line x1="64" y1="218" x2="${WIDTH - 64}" y2="218" stroke="#3a1010" stroke-width="1.5"/>
  <!-- 불릿 포인트들 -->
  ${bulletLines}
</svg>
`;

sharp(Buffer.from(svg))
  .jpeg({ quality: 92 })
  .toFile(OUT, (err) => {
    if (err) { console.error('❌', err.message); process.exit(1); }
    console.log(OUT);
  });
