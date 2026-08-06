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
    `${source}\nthis.__helpers = { applyImageCaption, buildBlogHTML, ensureIntroArticleSeparator, getOGCardStatus, imagePresentationOptions };`,
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
