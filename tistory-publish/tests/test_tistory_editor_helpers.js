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
