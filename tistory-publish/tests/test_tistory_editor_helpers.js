const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const helperPath = path.join(__dirname, '..', 'scripts', 'tistory-editor-helpers.js');
const source = fs.readFileSync(helperPath, 'utf8');

function loadHelpers() {
  const sandbox = {
    console,
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
    `${source}\nthis.__helpers = { applyImageCaption, buildBlogHTML, ensureIntroArticleSeparator, imagePresentationOptions };`,
    sandbox,
    { filename: helperPath },
  );
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
