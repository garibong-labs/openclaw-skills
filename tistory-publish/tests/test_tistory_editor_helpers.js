const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const helperPath = path.join(__dirname, '..', 'scripts', 'tistory-editor-helpers.js');
const source = fs.readFileSync(helperPath, 'utf8');

function loadHelpers() {
  const sandbox = {
    console,
    URL,
    window: {
      location: { href: 'https://example.tistory.com/manage/newpost' },
    },
    document: {
      createElement(tagName) {
        assert.strictEqual(tagName, 'figcaption');
        return {
          tagName: 'FIGCAPTION',
          textContent: '',
          removed: [],
          removeAttribute(name) {
            this.removed.push(name);
          },
        };
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${source}\nthis.__helpers = { applyImageCaption, buildBlogHTML, dcinsidePairedOGUrl, ensureIntroArticleSeparator, getOGCardStatus, getOGPlaceholderEntries, imagePresentationOptions, prepareOGRetry };`,
    sandbox,
    { filename: helperPath },
  );
  sandbox.__helpers.__sandbox = sandbox;
  return sandbox.__helpers;
}

function makeFigure() {
  return {
    tagName: 'FIGURE',
    caption: null,
    matches(selector) {
      return selector === 'figure[data-ke-type="image"]';
    },
    querySelector(selector) {
      return selector === 'figcaption' ? this.caption : null;
    },
    appendChild(node) {
      this.caption = node;
    },
  };
}

{
  const { applyImageCaption } = loadHelpers();
  const figure = makeFigure();
  const caption = applyImageCaption(figure, 'GPT Images 생성');

  assert.strictEqual(caption.textContent, 'GPT Images 생성');
  assert.deepStrictEqual(caption.removed, ['style', 'data-placeholder']);
  assert.strictEqual(figure.caption, caption);
}

{
  const { imagePresentationOptions } = loadHelpers();
  assert.strictEqual(
    JSON.stringify(imagePresentationOptions({
      filename: '00-comic.jpg',
      caption: 'GPT Images 생성',
    })),
    JSON.stringify({ width: 680, align: 'left', caption: 'GPT Images 생성' }),
  );
  assert.strictEqual(
    JSON.stringify(imagePresentationOptions({
      filename: '01-trend.jpg',
      caption: 'GPT Images 생성',
    })),
    JSON.stringify({ width: 0, align: '', caption: 'GPT Images 생성' }),
  );
}

{
  const { __sandbox, getOGCardStatus } = loadHelpers();
  const makeCard = (sourceUrl, title = '', anchorHref = '') => ({
    getAttribute(name) {
      return {
        'data-og-source-url': sourceUrl,
        'data-og-title': title,
      }[name] || '';
    },
    querySelector() {
      if (!anchorHref) return null;
      return {
        getAttribute(name) {
          return name === 'href' ? anchorHref : '';
        },
      };
    },
  });
  const cards = [
    makeCard('https://www.mk.co.kr/news/society/12106891', 'society'),
    makeCard('https://www.mk.co.kr/news/economy/12106887', 'economy'),
    makeCard('', 'world', 'https://www.mk.co.kr/news/world/12106889'),
  ];
  const setCards = nextCards => {
    __sandbox.tinymce = {
      activeEditor: {
        getBody() {
          return {
            querySelectorAll() {
              return nextCards;
            },
          };
        },
      },
    };
  };
  setCards(cards.slice(0, 2));

  const missingStatus = getOGCardStatus('https://www.mk.co.kr/news/world/12106889');
  assert.strictEqual(missingStatus.found, false);
  assert.strictEqual(missingStatus.ogCardCount, 2);
  assert.strictEqual(missingStatus.cards[0].matched, false);
  assert.strictEqual(missingStatus.cards[1].matched, false);

  setCards(cards);
  const matchedStatus = getOGCardStatus('https://www.mk.co.kr/news/economy/12106887/');
  assert.strictEqual(matchedStatus.found, true);
  assert.strictEqual(matchedStatus.cards[0].matched, false);
  assert.strictEqual(matchedStatus.cards[1].matched, true);

  const anchorMatchedStatus = getOGCardStatus('https://www.mk.co.kr/news/world/12106889/');
  assert.strictEqual(anchorMatchedStatus.found, true);
  assert.strictEqual(anchorMatchedStatus.cards[2].matched, true);

  const child = {
    getAttribute(name) {
      return name === 'href' ? 'https://www.mk.co.kr/news/economy/12106887' : '';
    },
    querySelector() {
      return null;
    },
    closest() {
      return figure;
    },
  };
  const figure = {
    getAttribute() {
      return '';
    },
    querySelector() {
      return child;
    },
    closest() {
      return figure;
    },
  };
  setCards([figure, child]);
  const nestedStatus = getOGCardStatus('https://www.mk.co.kr/news/economy/12106887');
  assert.strictEqual(nestedStatus.found, true);
  assert.strictEqual(nestedStatus.ogCardCount, 1);
}

{
  // Strict DCInside mobile/desktop pair — exact post routes only.
  const { dcinsidePairedOGUrl } = loadHelpers();
  assert.strictEqual(
    dcinsidePairedOGUrl('https://m.dcinside.com/board/ngm/270135'),
    'https://gall.dcinside.com/board/view/?id=ngm&no=270135',
  );
  assert.strictEqual(
    dcinsidePairedOGUrl('https://m.dcinside.com/board/comic_new6/5734260'),
    'https://gall.dcinside.com/board/view/?id=comic_new6&no=5734260',
  );
  assert.strictEqual(
    dcinsidePairedOGUrl('https://gall.dcinside.com/board/view/?id=comic_new6&no=5734260'),
    'https://m.dcinside.com/board/comic_new6/5734260',
  );
  for (const url of [
    'https://m.dcinside.com/board/ngm',
    'https://m.dcinside.com/board/ngm/270135?page=2',
    'https://m.dcinside.com/board/ngm/270135#comment',
    'https://m.dcinside.com/mini/ngm/270135',
    'https://m.dcinside.com/board/ngm/notanumber',
    'https://m.dcinside.com/search/gall_content?keyword=x',
    'https://gall.dcinside.com/board/view/?id=ngm&no=270135&page=2',
    'https://gall.dcinside.com/board/view/?id=ngm',
    'https://gall.dcinside.com/board/lists/?id=ngm',
    'https://theqoo.net/square/456',
    'not a url',
    '',
    null,
  ]) {
    assert.strictEqual(dcinsidePairedOGUrl(url), null, `expected null for ${url}`);
  }
}

{
  // getOGPlaceholderEntries — per-placeholder URL + ordered Daum next-source
  // fallback candidates (data-og-fallback-urls, whitespace-separated).
  // Missing/blank attributes fail closed to empty candidate lists, and the
  // placeholder order/count matches getOGPlaceholders.
  const { __sandbox, getOGPlaceholderEntries } = loadHelpers();

  // tinymce unavailable → empty list, no crash
  assert.deepStrictEqual([...getOGPlaceholderEntries()], []);

  const makePlaceholder = (url, fallbackAttr) => ({
    getAttribute(name) {
      if (name === 'data-og-placeholder') return url;
      if (name === 'data-og-fallback-urls') return fallbackAttr;
      return null;
    },
  });
  __sandbox.tinymce = {
    activeEditor: {
      getBody() {
        return {
          querySelectorAll(selector) {
            assert.strictEqual(selector, '[data-og-placeholder]');
            return [
              makePlaceholder(
                'https://v.daum.net/v/20260816090000001',
                '  https://v.daum.net/v/20260816090000002   https://v.daum.net/v/20260816090000003 ',
              ),
              makePlaceholder('https://theqoo.net/square/123', null),
              makePlaceholder('https://v.daum.net/v/20260816090000004', ''),
            ];
          },
        };
      },
    },
  };

  // vm realm의 Array라 spread로 host realm 배열로 정규화 후 비교
  const entries = [...getOGPlaceholderEntries()].map(entry => ({
    url: entry.url,
    fallbackUrls: [...entry.fallbackUrls],
  }));
  assert.deepStrictEqual(entries, [
    {
      url: 'https://v.daum.net/v/20260816090000001',
      fallbackUrls: [
        'https://v.daum.net/v/20260816090000002',
        'https://v.daum.net/v/20260816090000003',
      ],
    },
    { url: 'https://theqoo.net/square/123', fallbackUrls: [] },
    { url: 'https://v.daum.net/v/20260816090000004', fallbackUrls: [] },
  ]);
  delete __sandbox.tinymce;
}

{
  // Paired-identity matching: a successful mobile scrap may render a card
  // carrying the desktop canonical URL (and vice versa). Non-DCInside URLs
  // keep the normalized-exact matching.
  const { __sandbox, getOGCardStatus } = loadHelpers();
  const makeCard = sourceUrl => ({
    getAttribute(name) {
      return name === 'data-og-source-url' ? sourceUrl : '';
    },
    querySelector() {
      return null;
    },
  });
  const setCards = nextCards => {
    __sandbox.tinymce = {
      activeEditor: {
        initialized: true,
        getBody() {
          return {
            querySelectorAll() {
              return nextCards;
            },
          };
        },
      },
    };
  };

  setCards([makeCard('https://gall.dcinside.com/board/view/?id=comic_new6&no=5734260')]);
  const mobileExpected = getOGCardStatus('https://m.dcinside.com/board/comic_new6/5734260');
  assert.strictEqual(mobileExpected.found, true);

  setCards([makeCard('https://m.dcinside.com/board/comic_new6/5734260')]);
  const desktopExpected = getOGCardStatus('https://gall.dcinside.com/board/view/?id=comic_new6&no=5734260');
  assert.strictEqual(desktopExpected.found, true);

  // Query-bearing desktop variant is NOT the strict pair of the mobile post.
  setCards([makeCard('https://gall.dcinside.com/board/view/?id=comic_new6&no=5734260&page=2')]);
  const variantCard = getOGCardStatus('https://m.dcinside.com/board/comic_new6/5734260');
  assert.strictEqual(variantCard.found, false);

  // A different DCInside post never matches.
  setCards([makeCard('https://gall.dcinside.com/board/view/?id=comic_new6&no=9999999')]);
  const otherPost = getOGCardStatus('https://m.dcinside.com/board/comic_new6/5734260');
  assert.strictEqual(otherPost.found, false);

  // Non-DCInside URLs retain normalized-exact behavior.
  setCards([makeCard('https://theqoo.net/square/456')]);
  assert.strictEqual(getOGCardStatus('https://theqoo.net/square/456/').found, true);
  assert.strictEqual(getOGCardStatus('https://theqoo.net/square/457').found, false);
}

{
  // prepareOGRetry reuses the pending paragraph for a same-URL retry or a
  // confirmed paired-URL fallback, and drops empty Enter-split clones.
  const fromUrl = 'https://m.dcinside.com/board/comic_new6/5734260';
  const toUrl = 'https://gall.dcinside.com/board/view/?id=comic_new6&no=5734260';
  const makePending = text => ({
    text,
    attrs: { 'data-og-url-pending': fromUrl },
    removedCount: 0,
    get textContent() { return this.text; },
    set textContent(value) { this.text = value; },
    get firstChild() {
      return this.text ? { length: this.text.length } : null;
    },
    setAttribute(name, value) { this.attrs[name] = value; },
    remove() { this.removedCount += 1; },
  });
  const pendingWithText = makePending(fromUrl);
  const emptyClone = makePending('');
  const rangeCalls = [];
  const range = {
    setStart(node, offset) { rangeCalls.push(['start', node.length, offset]); },
    setEnd(node, offset) { rangeCalls.push(['end', node.length, offset]); },
  };
  let focused = false;
  let selectedRange = null;
  const helpers = loadHelpers();
  helpers.__sandbox.tinymce = {
    activeEditor: {
      initialized: true,
      getBody() {
        return {
          querySelectorAll(selector) {
            assert.ok(selector.includes(fromUrl));
            return [emptyClone, pendingWithText];
          },
        };
      },
      dom: { createRng: () => range },
      selection: { setRng(r) { selectedRange = r; } },
      focus() { focused = true; },
    },
  };
  const result = helpers.prepareOGRetry(fromUrl, toUrl);
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.fromUrl, fromUrl);
  assert.strictEqual(result.toUrl, toUrl);
  assert.strictEqual(pendingWithText.text, toUrl);
  assert.strictEqual(pendingWithText.attrs['data-og-url-pending'], toUrl);
  assert.strictEqual(emptyClone.removedCount, 1);
  assert.strictEqual(pendingWithText.removedCount, 0);
  assert.strictEqual(focused, true);
  assert.strictEqual(selectedRange, range);
  assert.deepStrictEqual(rangeCalls, [
    ['start', toUrl.length, toUrl.length],
    ['end', toUrl.length, toUrl.length],
  ]);

  // Missing pending paragraph fails closed.
  const emptyHelpers = loadHelpers();
  emptyHelpers.__sandbox.tinymce = {
    activeEditor: {
      initialized: true,
      getBody() {
        return { querySelectorAll: () => [] };
      },
      dom: { createRng: () => range },
      selection: { setRng() {} },
      focus() {},
    },
  };
  const missing = emptyHelpers.prepareOGRetry(fromUrl, toUrl);
  assert.strictEqual(missing.success, false);
  assert.ok(missing.error.includes('pending paragraph not found'));
}

{
  const { buildBlogHTML, ensureIntroArticleSeparator } = loadHelpers();
  const html = buildBlogHTML({
    intro: '<p data-ke-size="size16">intro</p>',
    articles: [{
      title: '① title',
      url: 'https://www.mk.co.kr/news/economy/123',
      body: '<p data-ke-size="size16">body</p>',
      commentLabel: '가리봉늬우스 코멘트:',
      comment: 'comment',
    }],
  });
  const separator = '<hr contenteditable="false" data-ke-type="horizontalRule" data-ke-style="style1">';

  assert.ok(
    html.includes(`<p data-ke-size="size16">intro</p>\n${separator}\n<h2 data-ke-size="size26">① title</h2>`),
  );
  assert.ok(
    html.includes('<p data-ke-size="size16">body</p>\n<p data-ke-size="size16">&nbsp;</p>\n<p data-ke-size="size16"><b>가리봉늬우스 코멘트:</b> - comment 끝.</p>'),
  );

  const rawHtml = [
    '<h2 data-ke-size="size26">들어가며</h2>',
    '<p data-ke-size="size16">intro</p>',
    '<h2 data-ke-size="size26">① title</h2>',
    '<p data-ke-size="size16">body</p>',
  ].join('\n');
  const normalizedHtml = ensureIntroArticleSeparator(rawHtml);
  assert.ok(
    normalizedHtml.includes(`<p data-ke-size="size16">intro</p>\n${separator}\n<h2 data-ke-size="size26">① title</h2>`),
  );
  assert.strictEqual(ensureIntroArticleSeparator(normalizedHtml), normalizedHtml);
}

console.log('tistory-editor-helpers tests passed');

// ── setRepresentImageFromEditor — 대표이미지 결정적 선택 (양쪽 helper 파일 동기화 검증) ──

const REPRESENT_HELPER_SCRIPTS = ['tistory-editor-helpers.js', 'tistory-publish.js'];

function loadRepresentImageHelper(scriptFile) {
  const scriptPath = path.join(__dirname, '..', 'scripts', scriptFile);
  const scriptSource = fs.readFileSync(scriptPath, 'utf8');
  const clicks = [];
  const button = {
    clicked: 0,
    click() {
      this.clicked += 1;
    },
  };
  const makeImg = (dataFilename, src) => ({
    src,
    getAttribute(name) {
      if (name === 'data-filename') return dataFilename;
      if (name === 'src') return src;
      return null;
    },
    click() {
      clicks.push(dataFilename || src);
    },
  });
  const images = [
    makeImg('00-comic.jpg', 'https://blog.kakaocdn.net/comic-upload'),
    makeImg('01-trend.jpg', 'https://blog.kakaocdn.net/primary-upload'),
    makeImg(null, 'https://blog.kakaocdn.net/02-trend.jpg'),
  ];
  const sandbox = {
    console,
    URL,
    setTimeout: fn => fn(),
    window: {
      location: { href: 'https://example.tistory.com/manage/newpost' },
    },
    document: {
      querySelector: sel => (sel === '.mce-represent-image-btn' ? button : null),
      querySelectorAll: () => [],
    },
    tinymce: {
      activeEditor: {
        getBody: () => ({
          querySelectorAll: sel => (sel === 'img' ? images : []),
          querySelector: () => null,
        }),
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${scriptSource}\nthis.__setRepresentImageFromEditor = setRepresentImageFromEditor;`,
    sandbox,
    { filename: scriptPath },
  );
  return { setRepresentImageFromEditor: sandbox.__setRepresentImageFromEditor, clicks, button };
}

(async () => {
  for (const scriptFile of REPRESENT_HELPER_SCRIPTS) {
    // 기본 동작: 옵션 없이 첫 번째 이미지 선택 (non-daum 템플릿 유지)
    {
      const { setRepresentImageFromEditor, clicks, button } = loadRepresentImageHelper(scriptFile);
      const result = await setRepresentImageFromEditor();
      assert.strictEqual(result.success, true, `${scriptFile}: default selection should succeed`);
      assert.deepStrictEqual(clicks, ['00-comic.jpg'], `${scriptFile}: default should click first image`);
      assert.strictEqual(button.clicked, 1);
      assert.strictEqual(result.imageUrl, 'https://blog.kakaocdn.net/comic-upload');
    }

    // daum-trends 대상 지정: comic을 건너뛰고 primary keyword 이미지 선택
    {
      const { setRepresentImageFromEditor, clicks, button } = loadRepresentImageHelper(scriptFile);
      const result = await setRepresentImageFromEditor({ targetFilename: '01-trend.jpg' });
      assert.strictEqual(result.success, true, `${scriptFile}: targeted selection should succeed`);
      assert.deepStrictEqual(clicks, ['01-trend.jpg'], `${scriptFile}: only the target image may be clicked`);
      assert.strictEqual(button.clicked, 1);
      assert.strictEqual(result.imageUrl, 'https://blog.kakaocdn.net/primary-upload');
      assert.strictEqual(result.targetFilename, '01-trend.jpg');
    }

    // data-filename이 없으면 src로도 매칭
    {
      const { setRepresentImageFromEditor, clicks } = loadRepresentImageHelper(scriptFile);
      const result = await setRepresentImageFromEditor({ targetFilename: '02-trend.jpg' });
      assert.strictEqual(result.success, true, `${scriptFile}: src matching should succeed`);
      assert.deepStrictEqual(clicks, ['https://blog.kakaocdn.net/02-trend.jpg']);
    }

    // 대상 미발견: 클릭 없이 실패 반환 (comic으로 silent fallback 금지)
    {
      const { setRepresentImageFromEditor, clicks, button } = loadRepresentImageHelper(scriptFile);
      const result = await setRepresentImageFromEditor({ targetFilename: '09-missing.jpg' });
      assert.strictEqual(result.success, false, `${scriptFile}: missing target must fail`);
      assert.ok(
        result.error.includes('representative target image not found'),
        `${scriptFile}: unexpected error: ${result.error}`,
      );
      assert.strictEqual(result.targetFilename, '09-missing.jpg');
      assert.deepStrictEqual(clicks, [], `${scriptFile}: missing target must not click any image`);
      assert.strictEqual(button.clicked, 0, `${scriptFile}: missing target must not touch represent button`);
      // editorImages는 vm realm의 Array라 spread로 host realm 배열로 정규화 후 비교
      assert.deepStrictEqual([...result.editorImages], [
        '00-comic.jpg',
        '01-trend.jpg',
        'https://blog.kakaocdn.net/02-trend.jpg',
      ]);
    }
  }
  console.log('setRepresentImageFromEditor tests passed');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

// ── convertPendingToPlainLink / verifyOGPlainLink / cleanup 보존 ──
// (확정 500/40009 plain-link 폴백 — 양쪽 helper 파일 동작·소스 동기화 검증)

const PLAIN_LINK_HELPER_SCRIPTS = ['tistory-editor-helpers.js', 'tistory-publish.js'];
const PLAIN_LINK_URL = 'https://ko.wikipedia.org/wiki/%EC%9E%A5%ED%95%9C%EB%B3%84';

// 1. 소스 parity: 두 helper 파일의 함수 본문이 정확히 같아야 한다 (드리프트 금지).
function extractFunctionSource(source, name, file) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${file}: function ${name} not found`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${file}: unbalanced braces for ${name}`);
}

{
  const sources = PLAIN_LINK_HELPER_SCRIPTS.map(file => ({
    file,
    source: fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8'),
  }));
  for (const name of ['convertPendingToPlainLink', 'verifyOGPlainLink']) {
    const [a, b] = sources.map(({ file, source }) => extractFunctionSource(source, name, file));
    assert.strictEqual(a, b, `${name} must stay byte-identical in both helper files`);
  }
  console.log('plain-link helper parity check passed');
}

// 2. 동작: pending 재사용/복제 제거/marker/anchor 안전 속성/검증.
function loadPlainLinkHelper(scriptFile) {
  const scriptPath = path.join(__dirname, '..', 'scripts', scriptFile);
  const scriptSource = fs.readFileSync(scriptPath, 'utf8');
  const sandbox = {
    console,
    URL,
    setTimeout: fn => fn(),
    window: { location: { href: 'https://example.tistory.com/manage/newpost' } },
    document: { querySelector: () => null, querySelectorAll: () => [] },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${scriptSource}\nthis.__plain = { convertPendingToPlainLink, verifyOGPlainLink, cleanupOGResiduals };`,
    sandbox,
    { filename: scriptPath },
  );
  sandbox.__plain.__sandbox = sandbox;
  return sandbox.__plain;
}

function makeAnchorFactory() {
  return (tag, attrs) => {
    assert.strictEqual(tag, 'a');
    return {
      tagName: 'A',
      attrs: { ...attrs },
      textContent: '',
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
      },
      setAttribute(name, value) { this.attrs[name] = value; },
    };
  };
}

function makePendingParagraph(text, pendingUrl) {
  return {
    tagName: 'P',
    text,
    attrs: { 'data-og-url-pending': pendingUrl },
    children: [],
    removedCount: 0,
    get textContent() { return this.text; },
    set textContent(value) { this.text = value; },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    appendChild(node) { this.children.push(node); },
    remove() { this.removedCount += 1; },
    querySelector(selector) {
      if (selector === 'a[href]') {
        return this.children.find(c => c.tagName === 'A' && c.getAttribute('href')) || null;
      }
      return null;
    },
  };
}

for (const scriptFile of PLAIN_LINK_HELPER_SCRIPTS) {
  // 변환 성공 + 검증 성공
  {
    const helpers = loadPlainLinkHelper(scriptFile);
    const pending = makePendingParagraph(PLAIN_LINK_URL, PLAIN_LINK_URL);
    const emptyClone = makePendingParagraph('', PLAIN_LINK_URL);
    let dirty = false;
    let saved = false;
    helpers.__sandbox.tinymce = {
      activeEditor: {
        initialized: true,
        getBody() {
          return {
            querySelectorAll(selector) {
              if (selector === `[data-og-url-pending="${PLAIN_LINK_URL}"]`) return [emptyClone, pending];
              if (selector === `[data-og-plain-link="${PLAIN_LINK_URL}"]`) {
                return pending.getAttribute('data-og-plain-link') ? [pending] : [];
              }
              return [];
            },
          };
        },
        dom: { create: makeAnchorFactory() },
        setDirty(value) { dirty = value; },
        save() { saved = true; },
      },
    };

    const result = helpers.convertPendingToPlainLink(PLAIN_LINK_URL);
    assert.strictEqual(result.success, true, `${scriptFile}: ${JSON.stringify(result)}`);
    assert.strictEqual(result.url, PLAIN_LINK_URL);
    assert.strictEqual(result.href, PLAIN_LINK_URL);
    assert.strictEqual(result.marker, 'data-og-plain-link');
    assert.strictEqual(result.duplicatesRemoved, 1);
    assert.strictEqual(emptyClone.removedCount, 1, `${scriptFile}: duplicate pending clone must be removed`);
    assert.strictEqual(pending.removedCount, 0);
    assert.strictEqual(pending.getAttribute('data-og-url-pending'), null, `${scriptFile}: pending attr must be removed`);
    assert.strictEqual(pending.getAttribute('data-og-plain-link'), PLAIN_LINK_URL, `${scriptFile}: durable marker required`);
    const anchor = pending.querySelector('a[href]');
    assert.ok(anchor, `${scriptFile}: anchor missing`);
    assert.strictEqual(anchor.getAttribute('href'), PLAIN_LINK_URL);
    assert.strictEqual(anchor.getAttribute('target'), '_blank');
    assert.strictEqual(anchor.getAttribute('rel'), 'noopener noreferrer');
    assert.strictEqual(anchor.textContent, PLAIN_LINK_URL, `${scriptFile}: visible source attribution required`);
    assert.strictEqual(dirty, true);
    assert.strictEqual(saved, true);

    const verify = helpers.verifyOGPlainLink(PLAIN_LINK_URL);
    assert.strictEqual(verify.found, true, `${scriptFile}: ${JSON.stringify(verify)}`);
    assert.strictEqual(verify.markerCount, 1);
    assert.strictEqual(verify.href, PLAIN_LINK_URL);
  }

  // pending 미발견 → 구조화 실패, 검증도 found=false
  {
    const helpers = loadPlainLinkHelper(scriptFile);
    helpers.__sandbox.tinymce = {
      activeEditor: {
        initialized: true,
        getBody() { return { querySelectorAll: () => [] }; },
        dom: { create: makeAnchorFactory() },
        setDirty() {},
        save() {},
      },
    };
    const result = helpers.convertPendingToPlainLink(PLAIN_LINK_URL);
    assert.strictEqual(result.success, false, scriptFile);
    assert.ok(result.error.includes('pending paragraph not found'), `${scriptFile}: ${result.error}`);
    const verify = helpers.verifyOGPlainLink(PLAIN_LINK_URL);
    assert.strictEqual(verify.found, false, scriptFile);
    assert.strictEqual(verify.markerCount, 0, scriptFile);
  }

  // tinymce 불가 → 구조화 실패 (fail-closed)
  {
    const helpers = loadPlainLinkHelper(scriptFile);
    assert.strictEqual(helpers.convertPendingToPlainLink(PLAIN_LINK_URL).success, false, scriptFile);
    assert.strictEqual(helpers.verifyOGPlainLink(PLAIN_LINK_URL).found, false, scriptFile);
  }

  // 검증은 anchor 속성 결함을 잡아낸다 (target/rel/href 불일치 → found=false)
  {
    const helpers = loadPlainLinkHelper(scriptFile);
    const pending = makePendingParagraph('', PLAIN_LINK_URL);
    delete pending.attrs['data-og-url-pending'];
    pending.setAttribute('data-og-plain-link', PLAIN_LINK_URL);
    const brokenAnchor = makeAnchorFactory()('a', { href: PLAIN_LINK_URL, target: '_self', rel: '' });
    pending.appendChild(brokenAnchor);
    helpers.__sandbox.tinymce = {
      activeEditor: {
        initialized: true,
        getBody() {
          return {
            querySelectorAll(selector) {
              return selector === `[data-og-plain-link="${PLAIN_LINK_URL}"]` ? [pending] : [];
            },
          };
        },
      },
    };
    const verify = helpers.verifyOGPlainLink(PLAIN_LINK_URL);
    assert.strictEqual(verify.found, false, `${scriptFile}: unsafe anchor must not verify`);
    assert.strictEqual(verify.target, '_self', scriptFile);
  }

  // cleanupOGResiduals: 마킹된 plain link는 mk.co.kr여도 보존, 마킹 없는
  // naked URL 잔여물은 기존대로 제거, plainLinks 수를 별도 보고.
  {
    const helpers = loadPlainLinkHelper(scriptFile);
    const markedMkLink = makePendingParagraph('https://www.mk.co.kr/news/economy/12106887', null);
    delete markedMkLink.attrs['data-og-url-pending'];
    markedMkLink.setAttribute('data-og-plain-link', 'https://www.mk.co.kr/news/economy/12106887');
    const nakedMkResidual = makePendingParagraph('https://www.mk.co.kr/news/society/12106891', null);
    delete nakedMkResidual.attrs['data-og-url-pending'];
    helpers.__sandbox.tinymce = {
      activeEditor: {
        initialized: true,
        getBody() {
          return {
            querySelectorAll(selector) {
              if (selector === '[data-og-url-pending]') return [];
              if (selector === 'p') return [markedMkLink, nakedMkResidual];
              if (selector === '[data-og-plain-link]') return [markedMkLink];
              return [];
            },
          };
        },
        setDirty() {},
        save() {},
      },
    };
    const cleanup = helpers.cleanupOGResiduals();
    assert.strictEqual(markedMkLink.removedCount, 0, `${scriptFile}: marked plain link must be preserved`);
    assert.strictEqual(nakedMkResidual.removedCount, 1, `${scriptFile}: unmarked naked URL must still be removed`);
    assert.strictEqual(cleanup.rawUrlsRemoved, 1, scriptFile);
    assert.strictEqual(cleanup.plainLinks, 1, `${scriptFile}: cleanup must report marked plain-link count`);
    assert.strictEqual(cleanup.ogCards, 0, `${scriptFile}: plain link must never count as an OG card`);
  }
}

console.log('convertPendingToPlainLink/verifyOGPlainLink/cleanup preservation tests passed');
